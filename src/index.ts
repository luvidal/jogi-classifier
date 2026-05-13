/**
 * @jogi/classifier - lean prompt-first document classifier.
 *
 * One Gemini call sees the whole file and returns final segments. Local code
 * only does geometry cleanup: duplicate collapse, exact same-range conflict
 * resolution, and PDF gap fill. No local OCR, anchors, page ledger, or doctype
 * detector.
 */

import { createHash } from 'crypto'
import { PDFDocument } from 'pdf-lib'
import { promptFor } from './prompt'

export interface Doctype {
    label: string
    definition?: string
    dateHint?: string
    freq?: 'once' | 'monthly' | 'annual'
    contains?: string[]
}
export type DoctypesMap = Record<string, Doctype>

export interface Segment {
    id: string
    start?: number
    end?: number
    confidence: number
    docdate?: string | null
    partId?: 'front' | 'back'
}

export interface ClassifyOptions {
    candidateIds?: string[]
}

export type GeminiCall = (params: { model: string; contents: any; config?: any }) => Promise<any>
export interface ClassifierConfig { doctypes: DoctypesMap; geminiCall: GeminiCall }

const CONFIG_KEY = Symbol.for('@jogi/classifier.config')
const g = globalThis as unknown as Record<symbol, ClassifierConfig | undefined>

export function configure(c: ClassifierConfig): void { g[CONFIG_KEY] = c }
function getConfig(): ClassifierConfig {
    const c = g[CONFIG_KEY]
    if (!c) throw new Error('@jogi/classifier: configure({ doctypes, geminiCall }) was not called')
    return c
}
export function getDoctypesMap(): DoctypesMap { return getConfig().doctypes }
export function getDoctypes(): Array<Doctype & { id: string }> {
    return Object.entries(getConfig().doctypes).map(([id, dt]) => ({ ...dt, id }))
}

export const NO_CLASIFICADO = 'no-clasificado'
const DEFAULT_MODEL = 'gemini-2.5-pro'
// Deterministic generation profile. Owned by this satellite — the host must
// not inject `model` or `generationConfig` at call time. Repeat classification
// of identical input is bit-identical (required by host slice-cache hits and
// request-level no-clasificado dedupe). `thinkingBudget: 1024` keeps Pro from
// burning the 8192-token output cap on internal reasoning.
const DEFAULT_GENERATION_CONFIG = {
    temperature: 0,
    topP: 0.1,
    seed: 1,
    candidateCount: 1,
    thinkingConfig: { thinkingBudget: 1024 },
} as const

export async function classify(buffer: Buffer, mimetype: string, opts: ClassifyOptions = {}): Promise<Segment[]> {
    const all = getDoctypes()
    const types = opts.candidateIds?.length ? all.filter(d => opts.candidateIds!.includes(d.id)) : all
    if (types.length === 0) return []

    const isPdf = mimetype === 'application/pdf'
    const totalPages = isPdf ? await pageCount(buffer) : 1
    const raw = await aiCall(buffer, mimetype, types, isPdf)
    const merged = mergeDuplicates(raw)
    const resolved = resolveSameRangeConflicts(merged)
    return isPdf ? fillGaps(resolved, totalPages) : resolved
}

async function pageCount(buf: Buffer): Promise<number> {
    return (await PDFDocument.load(Uint8Array.from(buf), { ignoreEncryption: true })).getPageCount()
}

function buildResponseSchema(ids: string[], isPdf: boolean): Record<string, unknown> {
    const itemProps: Record<string, unknown> = {
        id: { type: 'STRING', enum: ids },
        confidence: { type: 'NUMBER', minimum: 0, maximum: 1 },
        docdate: { type: 'STRING', nullable: true },
        partId: { type: 'STRING', enum: ['front', 'back'], nullable: true },
    }
    const required = ['id', 'confidence']
    if (isPdf) {
        itemProps.start = { type: 'INTEGER', minimum: 1 }
        itemProps.end = { type: 'INTEGER', minimum: 1 }
        required.push('start', 'end')
    }
    return {
        type: 'OBJECT',
        properties: { documents: { type: 'ARRAY', items: { type: 'OBJECT', properties: itemProps, required } } },
        required: ['documents'],
    }
}

async function aiCall(buf: Buffer, mimetype: string, types: Array<Doctype & { id: string }>, isPdf: boolean): Promise<Segment[]> {
    const ids = types.map(t => t.id)
    const r = await getConfig().geminiCall({
        model: DEFAULT_MODEL,
        contents: [{ role: 'user', parts: [{ inlineData: { mimeType: mimetype, data: buf.toString('base64') } }, { text: promptFor(types, isPdf) }] }],
        config: {
            ...DEFAULT_GENERATION_CONFIG,
            responseMimeType: 'application/json',
            responseSchema: buildResponseSchema(ids, isPdf),
        },
    })
    const text = (r?.text || r?.candidates?.[0]?.content?.parts?.map?.((p: any) => p?.text || '').join?.('') || '')
        .replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim()
    const docs = (JSON.parse(text || '{"documents":[]}')?.documents ?? []) as Segment[]
    return docs.filter(d => validSegment(d, isPdf))
}

function validSegment(d: Segment, isPdf: boolean): boolean {
    return !!d.id
        && typeof d.confidence === 'number'
        && d.confidence >= 0.5
        && (!isPdf || (Number.isInteger(d.start) && Number.isInteger(d.end) && d.start! >= 1 && d.end! >= d.start!))
}

function mergeDuplicates(segs: Segment[]): Segment[] {
    const out: Segment[] = []
    const used = new Set<number>()
    for (let i = 0; i < segs.length; i++) {
        if (used.has(i)) continue
        let cur = { ...segs[i] }
        for (let j = i + 1; j < segs.length; j++) {
            const o = segs[j]
            if (used.has(j) || o.id !== cur.id || (o.partId ?? null) !== (cur.partId ?? null)) continue
            const identicalRange = o.start === cur.start && o.end === cur.end
            const overlaps = cur.start != null && o.start != null && o.start <= cur.end! && o.end! >= cur.start
            const samePeriod = (o.docdate ?? null) === (cur.docdate ?? null)
            if (!identicalRange && !(overlaps && samePeriod)) continue
            if (o.confidence > cur.confidence) cur = { ...o, start: cur.start, end: cur.end }
            cur.start = cur.start != null ? Math.min(cur.start, o.start!) : o.start
            cur.end = cur.end != null ? Math.max(cur.end, o.end!) : o.end
            cur.confidence = Math.max(cur.confidence, o.confidence)
            used.add(j)
        }
        out.push(cur)
    }
    return out.sort(sortSegments)
}

function resolveSameRangeConflicts(segs: Segment[]): Segment[] {
    const groups = new Map<string, Segment[]>()
    for (const s of segs) {
        const key = `${s.start ?? ''}|${s.end ?? ''}|${s.partId ?? ''}`
        groups.set(key, [...(groups.get(key) ?? []), s])
    }
    return [...groups.values()].map(list =>
        list.length === 1 ? list[0] : list.reduce((best, s) => s.confidence > best.confidence ? s : best),
    ).sort(sortSegments)
}

function fillGaps(segs: Segment[], totalPages: number): Segment[] {
    const covered = new Set<number>()
    for (const s of segs) {
        if (s.start == null || s.end == null) continue
        for (let p = s.start; p <= s.end; p++) covered.add(p)
    }
    const gaps: Segment[] = []
    let run: number | null = null
    for (let p = 1; p <= totalPages + 1; p++) {
        if (p <= totalPages && !covered.has(p)) run ??= p
        else if (run != null) { gaps.push({ id: NO_CLASIFICADO, start: run, end: p - 1, confidence: 1 }); run = null }
    }
    return [...segs, ...gaps].sort(sortSegments)
}

function sortSegments(a: Segment, b: Segment): number {
    return (a.start ?? 0) - (b.start ?? 0) || (a.end ?? 0) - (b.end ?? 0) || a.id.localeCompare(b.id)
}

// Content-derived satellite fingerprint. Hashes the static prompt template
// (rules text, no doctype interpolation), response-schema shape, and
// deterministic generation profile. Used by the host as a cache-key shard so
// classifier prompt/schema/profile edits invalidate cached classifications;
// README/test/comment changes leave the hash inputs untouched.
let fingerprintCache: string | null = null
export function getClassifierFingerprint(): string {
    if (fingerprintCache !== null) return fingerprintCache
    const promptTemplate = promptFor([], true) + ' ' + promptFor([], false)
    const schema = JSON.stringify([buildResponseSchema([], true), buildResponseSchema([], false)])
    const profile = JSON.stringify(DEFAULT_GENERATION_CONFIG)
    fingerprintCache = createHash('sha256')
        .update(promptTemplate + ' ' + schema + ' ' + profile)
        .digest('hex')
        .slice(0, 12)
    return fingerprintCache
}

export function getClassifierProfile(): { model: string } {
    return { model: DEFAULT_MODEL }
}
