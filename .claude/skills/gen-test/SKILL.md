---
name: gen-test
description: Generate vitest tests for a module following project conventions
disable-model-invocation: true
---

# Generate Tests

Generate unit tests for the specified module.

## Conventions

- Test location: `tests/` directory
- File naming: `<module>.test.ts`
- Framework: `vitest` (no DOM env — pure Node)
- Imports: relative paths (`../src/...`), no `@/` aliases
- Stub the host-injected `geminiCall` with a fixture function — the library has no AI SDK runtime dep so there's nothing to mock at the network layer
- Use `pdf-lib` directly to create tiny synthetic PDFs for range/gap-fill tests

```typescript
import { describe, it, expect } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { classify, configure, type GeminiCall } from '../src/index'

function stubGemini(documents: Array<Record<string, unknown>>): GeminiCall {
  return async () => ({ text: JSON.stringify({ documents }) })
}
```

## Workflow

1. Read the target file to understand exports and behavior
2. If a test file exists, add missing cases rather than rewriting
3. Cover: happy path per export, confidence floor, fenced code stripping, mergeDuplicates, resolveSameRangeConflicts, fillGaps, partId splits, candidateIds narrowing
4. Run `npm test` to verify
5. Fix failures
