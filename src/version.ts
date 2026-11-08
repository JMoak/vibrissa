import { createRequire } from 'node:module'

// src/ and the published dist/ are both one directory below the manifest.
export const VERSION: string = createRequire(import.meta.url)('../package.json').version
