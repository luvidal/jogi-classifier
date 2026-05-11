/**
 * Run a small generation-parameter bakeoff against high-signal failures.
 *
 *   npm run param-sweep
 *   npm run param-sweep -- --full
 */

import * as fs from 'fs'
import * as path from 'path'
import { runGroundtruthComparison } from './groundtruth'

const WRONG_LABEL_FILES = [
    '_reqdocs/cta rara.png',
    'evaluacion/DAI 2024.pdf',
    'evaluacion/Inv Santander (1).pdf',
    'evaluacion/Inv Santander.pdf',
    'evaluacion/VentaProp Lo Barnechea.pdf',
    'evucina/Consumo Scotiabank.png',
    'evucina/Hipo Banco.pdf',
    'evucina/VentaProp Las Cabras.pdf',
    'evucina/VentaProp Lo Barnechea.pdf',
    'gloria/Carpeta.pdf',
    'yulian/YULIAN GARCIA/Cartola Santander.pdf',
]

const CONFIGS: Array<{ label: string; generationConfig?: Record<string, unknown> }> = [
    { label: 'baseline-defaults' },
    {
        label: 'deterministic',
        generationConfig: {
            temperature: 0,
            topP: 0.1,
            seed: 1,
            candidateCount: 1,
        },
    },
    {
        label: 'deterministic-think-1024',
        generationConfig: {
            temperature: 0,
            topP: 0.1,
            seed: 1,
            candidateCount: 1,
            thinkingConfig: { thinkingBudget: 1024 },
        },
    },
]

function stamp(): string {
    return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
}

async function main() {
    const full = process.argv.includes('--full')
    const outDir = path.resolve('out/param-sweep', stamp())
    fs.mkdirSync(outDir, { recursive: true })
    const summary = []
    for (const cfg of CONFIGS) {
        const outPath = path.join(outDir, `${cfg.label}.json`)
        const result = await runGroundtruthComparison({
            files: full ? undefined : new Set(WRONG_LABEL_FILES),
            outPath,
            classifyOptions: cfg.generationConfig ? { generationConfig: cfg.generationConfig } : undefined,
            label: cfg.label,
        })
        summary.push({
            label: cfg.label,
            generationConfig: cfg.generationConfig ?? null,
            passCount: result.passCount,
            total: result.total,
            passRate: result.total ? result.passCount / result.total : 0,
            outPath,
        })
    }
    const summaryPath = path.join(outDir, 'summary.json')
    fs.writeFileSync(summaryPath, JSON.stringify({ runAt: new Date().toISOString(), full, files: full ? 'all' : WRONG_LABEL_FILES, summary }, null, 2))
    console.log(`\nWrote ${summaryPath}`)
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
