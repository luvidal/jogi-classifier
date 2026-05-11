# Classifier Testing Notes

We are debugging the lean sandbox classifier, not rebuilding `@jogi/docs`.

Main goal: keep it fast, cheap, and simple. No OCR, page ledger, regex detector, local doctype detector, or pile of post-processing unless evidence forces it.

## What We Tested

Parameter sweep before prompt/definition changes:

- `baseline-defaults`: `0/11`
- `deterministic-cheap`: `2/11`
- `deterministic-think-1024`: `1/11`

Prompt sweep after stricter physical-document prompt:

- `baseline-defaults`: `2/11`
- `deterministic-cheap`: `2/11`
- `deterministic-think-1024`: `3/11`

Latest sweep after dominant-document prompt and definition tuning:

- `baseline-defaults`: `2/11`
- `deterministic-cheap`: `2/11`
- `deterministic-think-1024`: `4/11`

Pro check on the same 11 cases:

- `pro-defaults`: `6/11`
- `pro-deterministic-think-1024`: `7/11`

## Parameter Conclusion

Deterministic settings are hygiene, not the fix. They reduce variance but do not solve the hard failures.

Thinking helps somewhat on Flash, but Flash still fails core long-PDF boundary cases.

Best observed Flash config:

```ts
{
  temperature: 0,
  topP: 0.1,
  seed: 1,
  candidateCount: 1,
  thinkingConfig: { thinkingBudget: 1024 },
}
```

Best observed overall config:

```ts
{
  model: 'gemini-2.5-pro',
  generationConfig: {
    temperature: 0,
    topP: 0.1,
    seed: 1,
    candidateCount: 1,
    thinkingConfig: { thinkingBudget: 1024 },
  },
}
```

This is `7/11`, not a default recommendation. Pro is slower/costlier, and the remaining failures need review before deciding whether to change model routing, prompt, definitions, or ground truth.

## Prompt And Cost Notes

Full-catalog PDF prompt size:

- 25 doctypes.
- Assembled prompt: about 17.6k chars, roughly 4.4k tokens.
- Doctype block: about 15.0k chars, roughly 3.8k tokens, around 85% of the prompt.
- Static instructions: roughly 650 tokens.

Cost read as of 2026-05-08 from official Google pricing:

- Gemini 2.5 Flash: $0.30 / 1M input tokens, $2.50 / 1M output tokens.
- Gemini 2.5 Pro: $1.25 / 1M input tokens up to 200k prompt tokens, $2.50 / 1M input tokens above 200k.
- Gemini 2.5 Pro output: $10 / 1M tokens up to 200k prompt tokens, $15 / 1M above 200k.
- Classifier output is tiny JSON, so input dominates. Pro is roughly 4x Flash for normal docs and up to about 8x for very large PDFs.

Prompt conclusion:

- The catalog is not too large for context.
- The bigger risk is too many plausible competing labels in one prompt.
- Use `candidateIds` aggressively when parent Jogi request context knows expected requirements, then keep full-catalog fallback for out-of-context uploads.
- Do not blindly shorten definitions; the long contrast rules may be helping with close labels.

## Real Problem

There are two problems: labels and boundaries.

Labels are document type IDs like `compraventa-propiedad`, `deuda-consumo`, `cartola-banco`, etc.

Boundaries are page ranges, like whether a 99-page PDF is one document or many documents.

The most important Flash failure is boundaries. Gemini Flash often recognizes page content plausibly, but it over-segments long legal PDFs.

Example: a 99-page VentaProp file should be one `compraventa-propiedad` range, but Gemini splits it into mortgage debt, SII pages, certificates, appraisals, etc.

Short files are mostly label-boundary issues. Long files are mostly document-boundary issues.

Pro deterministic fixed the long VentaProp boundary cases in the 11-case suite, including both 99-page Lo Barnechea files and the 20-page Las Cabras file. That weakens the case for adding a local dominance/range rule before broader Pro validation.

## Sweep Page Counts

- `cta rara.png`: 1
- `DAI 2024.pdf`: 1
- `Inv Santander (1).pdf`: 1
- `Inv Santander.pdf`: 1
- `VentaProp Lo Barnechea.pdf`: 99
- `Consumo Scotiabank.png`: 1
- `Hipo Banco.pdf`: 1
- `VentaProp Las Cabras.pdf`: 20
- `VentaProp Lo Barnechea.pdf`: 99
- `gloria/Carpeta.pdf`: 15
- `Cartola Santander.pdf`: 3

Hard failures are mostly the 20/99-page legal packets plus `gloria/Carpeta.pdf`.

## Prompt Rule Added

The latest prompt rule:

> Classify the upload by the dominant standalone document it represents; do not mine internal pages for every possible doctype.

This helped somewhat, but Gemini still fragments long PDFs.

## Definition Tuning Done

- DAI vs boletas SII
- `cartola-banco` vs `deuda-consumo`
- `deuda-hipotecaria` vs notarial mortgage clauses
- `inversiones` vs `compraventa-propiedad`
- `compraventa-propiedad` as long deed/legal packet

More specifically:

- DAI now requires visible F22/Impuestos Anuales title.
- Boletas are explicitly separate from F22/DAI.
- `cartola-banco` excludes credit card statements and clear debt details.
- `deuda-consumo` includes credit card statements and bank portal debt rows.
- `deuda-hipotecaria` rejects interior notarial/mutuo clauses.
- `compraventa-propiedad` includes long certified deed packets and tells Gemini not to split internal annexes.
- `inversiones` rejects notarial/compraventa documents even if the filename says investment.

## Disputed Ground Truth

Some ground truth rows look disputed:

- `evaluacion/DAI 2024.pdf` visually looks like boletas/F29 content, not F22 DAI.
- `evaluacion/Inv Santander*.pdf` visually look like notarial compraventa certificates, not inversiones.

We did not remove them from the sweep because the original 11-case set is being preserved for trend continuity.

## Architecture Facts

The lean classifier architecture:

- `classify()` makes one Gemini call over the full file.
- It returns final `Segment` rows.
- Local code only does duplicate collapse, same-range conflict resolution, and PDF gap fill.
- It does not use OCR, anchors, page ledger, or local doctype detection.

Gemini wrapper behavior from Jogi:

- `lib/server/gemini.ts` honors explicit caller `thinkingConfig`.
- Default Flash still gets `thinkingBudget: 0` unless caller provides `thinkingConfig`.
- This made the sweep able to test `thinkingBudget: 1024`.

## Preserved Artifacts

- `docs/artifacts/opus/groundtruth-from-sweep.json`
- `docs/artifacts/opus/sweep.json`
- `docs/artifacts/opus/param-sweep/20260507213054/`
- `docs/artifacts/opus/param-sweep/20260507213642/`
- `docs/artifacts/opus/param-sweep/20260507231216/`

These were copied out of Jogi's old `tests/opus/out/` sandbox before the sandbox was removed.

Key latest artifact:

- `docs/artifacts/opus/param-sweep/20260507231216/summary.json`

## Latest Flash Thinking-1024 Results

Passing cases:

- `_reqdocs/cta rara.png` -> `cuenta-ahorro`
- `evucina/Consumo Scotiabank.png` -> `deuda-consumo`
- `evucina/Hipo Banco.pdf` -> `no-clasificado`
- `yulian/YULIAN GARCIA/Cartola Santander.pdf` -> `deuda-consumo`

Still failing cases:

- `evaluacion/DAI 2024.pdf` -> `resumen-boletas-sii`, expected DAI
- `evaluacion/Inv Santander (1).pdf` -> `compraventa-propiedad`, expected inversiones
- `evaluacion/Inv Santander.pdf` -> `compraventa-propiedad`, expected inversiones
- `evaluacion/VentaProp Lo Barnechea.pdf` -> mostly `compraventa-propiedad` chunks, but not one `1..99` range, with rogue `resumen-boletas-sii` and `cedula-identidad`
- `evucina/VentaProp Las Cabras.pdf` -> split into compraventa/no-clasificado/inversiones/DAI/deuda-comercial
- `evucina/VentaProp Lo Barnechea.pdf` -> still heavily split
- `gloria/Carpeta.pdf` -> false positives inside a judicial/insolvency packet

## Latest Pro Results

Run artifact:

- `out/param-sweep/20260508122415-pro/summary.json`

`pro-defaults`: `6/11`

`pro-deterministic-think-1024`: `7/11`

Passing cases for `pro-deterministic-think-1024`:

- `_reqdocs/cta rara.png` -> `cuenta-ahorro`
- `evaluacion/VentaProp Lo Barnechea.pdf` -> `compraventa-propiedad@1..99`
- `evucina/Consumo Scotiabank.png` -> `deuda-consumo`
- `evucina/VentaProp Las Cabras.pdf` -> `compraventa-propiedad@1..20`
- `evucina/VentaProp Lo Barnechea.pdf` -> `compraventa-propiedad@1..99`
- `gloria/Carpeta.pdf` -> `no-clasificado@1..15`
- `yulian/YULIAN GARCIA/Cartola Santander.pdf` -> `deuda-consumo@1..3`

Failing cases for `pro-deterministic-think-1024`:

- `evaluacion/DAI 2024.pdf` -> `resumen-boletas-sii`, expected DAI
- `evaluacion/Inv Santander (1).pdf` -> `compraventa-propiedad`, expected inversiones
- `evaluacion/Inv Santander.pdf` -> `compraventa-propiedad`, expected inversiones
- `evucina/Hipo Banco.pdf` -> `compraventa-propiedad`, expected no-clasificado

## Product Inference

For upload classification, the product cares more about the dominant uploaded document than every possible internal content type.

Annex pages inside a legal packet usually are not useful separate requirements.

Flash is better at simple label confusion than it was, but still struggles with long-packet ranges. Pro deterministic fixed the long-packet ranges in this suite, so the remaining question is whether to pay for or selectively route to Pro rather than adding local range logic.

## Full Corpus Pro Validation

Latest full-corpus run:

- Artifact: `out/full-pro-deterministic-20260508-rerun.json`
- Corpus: `~/Downloads/docs`
- Config: `gemini-2.5-pro` with `temperature: 0`, `topP: 0.1`, `seed: 1`, `candidateCount: 1`, `thinkingBudget: 1024`
- Result: `173/197` strict pass

Main remaining error classes:

- Strict range clipping/final-page misses: CMF debt reports, `m4lt1-2.pdf`, VentaProp Santiago, VentaProp Las Cabras.
- Container-child policy mismatch: Carpeta Tributaria files return container plus internal SII child docs, while ground truth expects only the container.
- Long legal-packet child false positives: Lo Barnechea packets keep the full `compraventa-propiedad` range but also emit internal certificates/SII/credit/DS1 pages.
- Disputed labels: `DAI 2024.pdf` looks like boletas/F29 content; `Inv Santander*.pdf` looks like notarial compraventa material.
- `no-clasificado` false positives: `Hipo Banco.pdf`, `Avalúo_2.pdf`, `gloria/Carpeta.pdf`, `gloria/Deuda.pdf`, and `pago tajeta santander.png`.
- Other label edges: Scotiabank cartola/consumo and cedula front/back handling.

Conclusion: Pro is a clear improvement over Flash and keeps the runtime simple, but a global prompt/catalog change is unlikely to reach 100% cleanly without either product-context routing, candidate narrowing, or ground-truth decisions.

## Candidate Narrowing Probe

`candidateIds` is the best simple lever found so far:

- Debt-family candidate sets classify `Hipo Banco.pdf` as `no-clasificado`.
- Including broad `compraventa-propiedad` in that slot reintroduces the false positive.
- DAI-vs-boletas and inversiones-vs-compraventa still choose the visible competing label, which supports ground-truth review before prompt overfitting.
- Legal packet slots should keep full catalog context; narrow legal candidates regressed range behavior.

## Current Likely Next Steps

Do not add local machinery yet.

Pro deterministic is the current baseline.

Next improvement should happen in the parent product routing: use `candidateIds` for requirement slots that already know the expected document family, especially debt-family slots that should not include `compraventa-propiedad`.

Before changing prompt/definitions again, decide the ground-truth/product policy for container files and the disputed DAI/Santander labels.

Fresh-session handoff:

- Read `CLAUDE.md` first.
- Do not edit `AGENTS.md`.
- Continue from Pro result `7/11` in `out/param-sweep/20260508122415-pro/summary.json`.
- Do not touch parent `../jogi` unless explicitly asked.
- Current broad validation: `173/197` strict pass in `out/full-pro-deterministic-20260508-rerun.json`.
- Next concrete task: integrate or test parent-side `candidateIds` routing, then review container/disputed-label ground truth.

Open question:

Whether to accept a small dominance/range consolidation rule is less urgent after Pro deterministic fixed the legal-packet ranges in this suite.

Example: if Gemini returns many `compraventa-propiedad` chunks across a long PDF plus rogue internal labels, consolidate to one full-range `compraventa-propiedad`.

We have not implemented that because it smells like a local patch and the current instruction is to try model/prompt/definitions first.
