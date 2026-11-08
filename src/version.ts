import manifest from '../package.json' with { type: 'json' }

// Bundlers inline this value. prepack rebuilds after the release job assigns the version.
export const VERSION: string = manifest.version
