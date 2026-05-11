/**
 * Compare @jogi/classifier against CLASSIFICATION.md files.
 *
 *   npm run groundtruth -- [--only=substr] [--out=out/groundtruth.json]
 *   npm run groundtruth -- --actual=out/sweep.json --out=out/groundtruth-from-sweep.json
 */

import 'dotenv/config'
import * as fs from 'fs'
import * as path from 'path'
import { GoogleGenAI } from '@google/genai'
import { classify, configure, NO_CLASIFICADO, type DoctypesMap, type GeminiCall, type Segment } from '../src/index'

const ROOT = process.env.CORPUS_ROOT || '/Users/avd/Downloads/docs'
const DOCTYPES_PATH = process.env.JOGI_DOCTYPES || '/Users/avd/GitHub/jogi/data/doctypes.json'

interface ExpectedSegment {
    id: string
    start?: number
    end?: number
    partId?: 'front' | 'back'
}

interface GroundtruthCase {
    file: string
    absPath: string
    expected: ExpectedSegment[]
    source: string
}

export interface Result {
    file: string
    source: string
    expected: ExpectedSegment[]
    actual: Array<Pick<Segment, 'id' | 'start' | 'end' | 'confidence' | 'partId' | 'docdate'>>
    pass: boolean
    durationMs: number
    error?: string
}

function geminiCall(): GeminiCall {
    const apiKey = process.env.GEMINI_API_KEY
    const project = process.env.GOOGLE_CLOUD_PROJECT
    const location = process.env.GOOGLE_CLOUD_LOCATION
    const ai = apiKey
        ? new GoogleGenAI({ apiKey })
        : project && location
            ? new GoogleGenAI({ vertexai: true, project, location } as any)
            : null
    if (!ai) throw new Error('Set GEMINI_API_KEY or GOOGLE_CLOUD_PROJECT + GOOGLE_CLOUD_LOCATION')
    return ({ model, contents, config }) => ai.models.generateContent({ model, contents, config })
}

function ensureConfigured(): void {
    if (!fs.existsSync(DOCTYPES_PATH)) throw new Error(`doctypes.json missing at ${DOCTYPES_PATH}`)
    configure({ doctypes: JSON.parse(fs.readFileSync(DOCTYPES_PATH, 'utf8')) as DoctypesMap, geminiCall: geminiCall() })
}

function mimetypeFor(filename: string): string | null {
    const ext = path.extname(filename).toLowerCase()
    if (ext === '.pdf') return 'application/pdf'
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
    if (ext === '.png') return 'image/png'
    if (ext === '.webp') return 'image/webp'
    return null
}

export function findClassificationFiles(): string[] {
    const out: string[] = []
    function walk(dir: string) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name)
            if (e.isDirectory()) walk(p)
            else if (e.name === 'CLASSIFICATION.md') out.push(p)
        }
    }
    walk(ROOT)
    return out.sort()
}

function splitRow(line: string): string[] {
    return line.slice(1, line.endsWith('|') ? -1 : undefined).split('|').map(c => c.trim())
}

function parseRange(raw: string): { start?: number; end?: number } {
    const text = raw.trim()
    if (!text || text === '-' || text === '—') return {}
    const m = /^(\d+)\s*(?:-|–|—)\s*(\d+)$/.exec(text) || /^(\d+)$/.exec(text)
    if (!m) return {}
    const start = Number(m[1])
    const end = Number(m[2] ?? m[1])
    return Number.isInteger(start) && Number.isInteger(end) ? { start, end } : {}
}

function normalizeId(raw: string): string {
    return raw.replace(/`/g, '').replace(/^\((.+)\)$/, '$1').trim()
}

function partFromText(text: string): 'front' | 'back' | null {
    const t = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    if (/\bfrente\b/.test(t) && !/\breves\b|\breverso\b/.test(t)) return 'front'
    if (/\breves\b|\breverso\b/.test(t) && !/\bfrente\b/.test(t)) return 'back'
    return null
}

function isCompositeCedula(cells: Record<string, string>, id: string): boolean {
    if (id !== 'cedula-identidad') return false
    const text = Object.values(cells).join(' ').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    return /frente\s*\+\s*reves/.test(text) || /composite split|compuesta|frente\s*\/\s*reves/.test(text)
}

function expectedFromRow(headers: string[], values: string[]): ExpectedSegment[] {
    const row = Object.fromEntries(headers.map((h, i) => [h.toLowerCase(), values[i] ?? '']))
    const id = normalizeId(row.doc_type_id ?? '')
    if (!id || id === 'doc_type_id') return []
    const range = parseRange(row.range ?? '')
    if (isCompositeCedula(row, id)) {
        return [
            { id, ...range, partId: 'front' },
            { id, ...range, partId: 'back' },
        ]
    }
    const part = partFromText(`${row.part ?? ''} ${row.notes ?? ''} ${row['short label'] ?? ''}`)
    return [{ id, ...range, ...(part ? { partId: part } : {}) }]
}

export function parseClassificationFile(file: string): GroundtruthCase[] {
    const md = fs.readFileSync(file, 'utf8')
    const dir = path.dirname(file)
    const relSource = path.relative(ROOT, file)
    const byFile = new Map<string, ExpectedSegment[]>()
    let headers: string[] | null = null
    for (const line of md.split(/\r?\n/)) {
        if (!line.startsWith('|')) continue
        const cells = splitRow(line)
        if (cells.some(c => c === '---' || /^-+$/.test(c))) continue
        if (!headers && cells.map(c => c.toLowerCase()).includes('file')) { headers = cells; continue }
        if (!headers) continue
        const row = Object.fromEntries(headers.map((h, i) => [h.toLowerCase(), cells[i] ?? '']))
        const filename = row.file
        if (!filename || filename === 'File') continue
        const expected = expectedFromRow(headers, cells)
        if (expected.length === 0) continue
        byFile.set(filename, [...(byFile.get(filename) ?? []), ...expected])
    }
    return [...byFile.entries()].map(([filename, expected]) => {
        const absPath = path.join(dir, filename)
        return { file: path.relative(ROOT, absPath), absPath, expected, source: relSource }
    })
}

function segmentMatches(actual: Segment, expected: ExpectedSegment): boolean {
    return actual.id === expected.id
        && (expected.start == null || actual.start === expected.start)
        && (expected.end == null || actual.end === expected.end)
        && (expected.partId == null || actual.partId === expected.partId)
}

function describeExpected(e: ExpectedSegment): string {
    return `${e.id}${e.start != null ? `@${e.start}..${e.end}` : ''}${e.partId ? `(${e.partId})` : ''}`
}

function describeActual(s: Pick<Segment, 'id' | 'start' | 'end' | 'partId'>): string {
    return `${s.id}${s.start != null ? `@${s.start}..${s.end}` : ''}${s.partId ? `(${s.partId})` : ''}`
}

async function runOne(c: GroundtruthCase, classifyOptions?: { model?: string; generationConfig?: Record<string, unknown> }): Promise<Result> {
    const mt = mimetypeFor(c.absPath)
    const t0 = Date.now()
    if (!mt) return { file: c.file, source: c.source, expected: c.expected, actual: [], pass: false, durationMs: 0, error: 'unsupported mimetype' }
    if (!fs.existsSync(c.absPath)) return { file: c.file, source: c.source, expected: c.expected, actual: [], pass: false, durationMs: 0, error: 'file missing' }
    try {
        const segs = await classify(fs.readFileSync(c.absPath), mt, classifyOptions)
        return compareActual(c, segs, Date.now() - t0)
    } catch (err) {
        return { file: c.file, source: c.source, expected: c.expected, actual: [], pass: false, durationMs: Date.now() - t0, error: String(err instanceof Error ? err.message : err) }
    }
}

function loadActuals(actualPath: string | null): Map<string, Segment[]> | null {
    if (!actualPath) return null
    const raw = JSON.parse(fs.readFileSync(actualPath, 'utf8'))
    const out = new Map<string, Segment[]>()
    for (const r of raw.results ?? []) if (typeof r.file === 'string') out.set(r.file, Array.isArray(r.actual) ? r.actual : [])
    return out
}

function compareActual(c: GroundtruthCase, segs: Segment[], durationMs = 0): Result {
    const actual = segs.map(s => ({ id: s.id, start: s.start, end: s.end, confidence: s.confidence, partId: s.partId, docdate: s.docdate }))
    const missing = c.expected.filter(e => !segs.some(s => segmentMatches(s, e)))
    const expectedIds = new Set(c.expected.map(e => e.id))
    const unexpected = segs.filter(s => {
        if (c.expected.some(e => segmentMatches(s, e))) return false
        return s.id !== NO_CLASIFICADO || expectedIds.has(NO_CLASIFICADO)
    })
    const pass = missing.length === 0 && unexpected.length === 0
    const errors = [
        ...missing.map(e => `missing ${describeExpected(e)}`),
        ...unexpected.map(s => `unexpected ${describeActual(s)}`),
    ]
    return { file: c.file, source: c.source, expected: c.expected, actual, pass, durationMs, error: errors.length ? errors.join('; ') : undefined }
}

function parseGenerationConfig(argv: string[]): { model?: string; generationConfig?: Record<string, unknown>; label: string } {
    let model: string | undefined
    const generationConfig: Record<string, unknown> = {}
    const labelParts: string[] = []
    for (const a of argv) {
        const setNumber = (name: string, key = name) => {
            if (!a.startsWith(`--${name}=`)) return false
            const value = Number(a.slice(name.length + 3))
            if (Number.isFinite(value)) { generationConfig[key] = value; labelParts.push(`${key}-${String(value).replace('-', 'neg')}`) }
            return true
        }
        if (a.startsWith('--model=')) { model = a.slice('--model='.length); labelParts.push(`model-${model}`) }
        else if (setNumber('temperature') || setNumber('topP') || setNumber('topK') || setNumber('candidateCount') || setNumber('seed')) continue
        else if (a.startsWith('--thinkingBudget=')) {
            const value = Number(a.slice('--thinkingBudget='.length))
            if (Number.isFinite(value)) { generationConfig.thinkingConfig = { thinkingBudget: value }; labelParts.push(`thinking-${String(value).replace('-', 'neg')}`) }
        }
    }
    return { ...(model ? { model } : {}), generationConfig: Object.keys(generationConfig).length ? generationConfig : undefined, label: labelParts.length ? labelParts.join('__') : 'default' }
}

function writeRun(outPath: string, label: string, classifyOptions: unknown, results: Result[]): void {
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, JSON.stringify({ runAt: new Date().toISOString(), label, classifyOptions, results }, null, 2))
}

export async function runGroundtruthComparison(args: {
    only?: string | null
    files?: Set<string>
    outPath: string
    actualPath?: string | null
    classifyOptions?: { model?: string; generationConfig?: Record<string, unknown> }
    label?: string
}): Promise<{ results: Result[]; passCount: number; total: number }> {
    const { only = null, files, outPath, actualPath = null, classifyOptions, label = 'default' } = args
    const actuals = loadActuals(actualPath)
    if (!actuals) ensureConfigured()
    const cases = findClassificationFiles().flatMap(parseClassificationFile)
        .filter(c => !files || files.has(c.file))
        .filter(c => !only || c.file.toLowerCase().includes(only.toLowerCase()) || c.source.toLowerCase().includes(only.toLowerCase()))
    console.log(`Running ${cases.length} groundtruth cases${only ? ` (filter: ${only})` : ''}${actualPath ? ` (actual: ${actualPath})` : ''} (label: ${label})\n`)
    const results: Result[] = []
    for (const c of cases) {
        const r = actuals
            ? actuals.has(c.file)
                ? compareActual(c, actuals.get(c.file)!)
                : { file: c.file, source: c.source, expected: c.expected, actual: [], pass: false, durationMs: 0, error: 'no saved actual for file' }
            : await runOne(c, classifyOptions)
        results.push(r)
        const tag = r.pass ? 'PASS' : 'FAIL'
        console.log(`${tag}  ${r.durationMs}ms  ${r.file}\n      expected: [${r.expected.map(describeExpected).join(', ')}]\n      actual:   [${r.actual.map(describeActual).join(', ')}]${r.error ? `\n      ERROR: ${r.error}` : ''}`)
        writeRun(outPath, label, classifyOptions, results)
    }
    const passCount = results.filter(r => r.pass).length
    console.log(`\n${passCount}/${results.length} pass (${results.length ? (passCount / results.length * 100).toFixed(0) : '0'}%)`)
    console.log(`Wrote ${outPath}`)
    return { results, passCount, total: results.length }
}

async function main() {
    let only: string | null = null
    let outPath = path.resolve('out/groundtruth.json')
    let actualPath: string | null = null
    for (const a of process.argv.slice(2)) {
        if (a.startsWith('--only=')) only = a.slice('--only='.length)
        else if (a.startsWith('--out=')) outPath = path.resolve(a.slice('--out='.length))
        else if (a.startsWith('--actual=')) actualPath = path.resolve(a.slice('--actual='.length))
    }
    const parsed = parseGenerationConfig(process.argv.slice(2))
    await runGroundtruthComparison({
        only,
        outPath,
        actualPath,
        classifyOptions: {
            ...(parsed.model ? { model: parsed.model } : {}),
            ...(parsed.generationConfig ? { generationConfig: parsed.generationConfig } : {}),
        },
        label: parsed.label,
    })
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
    main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
}
