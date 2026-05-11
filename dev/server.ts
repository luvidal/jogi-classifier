import 'dotenv/config'
import * as fs from 'fs'
import * as http from 'http'
import * as path from 'path'
import { GoogleGenAI } from '@google/genai'
import { classify, configure, type DoctypesMap, type GeminiCall } from '../src/index'

const PORT = Number(process.env.PORT || 4177)
const ROOT = path.resolve(__dirname)
const DOCTYPES_PATH = process.env.JOGI_DOCTYPES || '/Users/avd/GitHub/jogi/data/doctypes.json'

interface UploadItem {
    path?: string
    name: string
    type?: string
    data: string
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

let configured = false

function configureClassifier(): void {
    if (configured) return
    if (!fs.existsSync(DOCTYPES_PATH)) throw new Error(`doctypes.json missing at ${DOCTYPES_PATH}`)
    configure({
        doctypes: JSON.parse(fs.readFileSync(DOCTYPES_PATH, 'utf8')) as DoctypesMap,
        geminiCall: geminiCall(),
    })
    configured = true
}

function mimetypeFor(name: string, provided?: string): string {
    if (provided) return provided
    const ext = path.extname(name).toLowerCase()
    if (ext === '.pdf') return 'application/pdf'
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
    if (ext === '.png') return 'image/png'
    if (ext === '.webp') return 'image/webp'
    return 'application/octet-stream'
}

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let body = ''
        req.setEncoding('utf8')
        req.on('data', chunk => {
            body += chunk
            if (body.length > 80 * 1024 * 1024) {
                reject(new Error('Request too large'))
                req.destroy()
            }
        })
        req.on('end', () => resolve(body))
        req.on('error', reject)
    })
}

function sendJson(res: http.ServerResponse, status: number, value: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(value, null, 2))
}

async function classifyUploads(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = JSON.parse(await readBody(req)) as {
        files?: UploadItem[]
        model?: string
        generationConfig?: Record<string, unknown>
    }
    const files = body.files ?? []
    if (!Array.isArray(files) || files.length === 0) {
        sendJson(res, 400, { error: 'No files provided' })
        return
    }
    configureClassifier()
    const results = []
    for (const file of files) {
        const started = Date.now()
        try {
            const buffer = Buffer.from(file.data, 'base64')
            const mimetype = mimetypeFor(file.name, file.type)
            if (!['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].includes(mimetype)) {
                results.push({ path: file.path || file.name, pass: false, error: `Unsupported mimetype: ${mimetype}`, durationMs: 0 })
                continue
            }
            const segments = await classify(buffer, mimetype, {
                ...(body.model ? { model: body.model } : {}),
                ...(body.generationConfig ? { generationConfig: body.generationConfig } : {}),
            })
            results.push({ path: file.path || file.name, mimetype, durationMs: Date.now() - started, segments })
        } catch (err) {
            results.push({ path: file.path || file.name, durationMs: Date.now() - started, error: String(err instanceof Error ? err.message : err) })
        }
    }
    sendJson(res, 200, { runAt: new Date().toISOString(), count: results.length, results })
}

function contentType(file: string): string {
    if (file.endsWith('.html')) return 'text/html; charset=utf-8'
    if (file.endsWith('.js')) return 'text/javascript; charset=utf-8'
    if (file.endsWith('.css')) return 'text/css; charset=utf-8'
    return 'application/octet-stream'
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url || '/', `http://localhost:${PORT}`)
    const file = path.normalize(url.pathname === '/' ? 'index.html' : url.pathname.slice(1))
    const target = path.resolve(ROOT, file)
    if (!target.startsWith(ROOT) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
        res.writeHead(404)
        res.end('Not found')
        return
    }
    res.writeHead(200, { 'content-type': contentType(target) })
    fs.createReadStream(target).pipe(res)
}

const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/classify') {
        classifyUploads(req, res).catch(err => sendJson(res, 500, { error: String(err instanceof Error ? err.message : err) }))
        return
    }
    if (req.method === 'GET') {
        serveStatic(req, res)
        return
    }
    res.writeHead(405)
    res.end('Method not allowed')
})

server.listen(PORT, () => {
    console.log(`@jogi/classifier playground: http://localhost:${PORT}`)
    console.log(`doctypes: ${DOCTYPES_PATH}`)
})
