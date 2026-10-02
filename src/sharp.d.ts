/**
 * The slice of `sharp` this package uses, declared locally so type-checking
 * never depends on the optional native binary being installed.
 *
 * `sharp` is a ~30 MB platform-specific dependency and WebP conversion is a
 * nice-to-have here (see `comfy/media.ts` — without it renders stay PNG and
 * nothing breaks), so it stays in `optionalDependencies` and this declaration
 * gives the compiler the same answer whether or not the install picked it up.
 * The game CLI keeps its own copy at `src/cli/images/sharp.d.ts`; this package
 * ships standalone and may import nothing from the game.
 */
declare module 'sharp' {
  interface SharpImage {
    resize(options: { width?: number; height?: number }): SharpImage
    webp(options: { quality?: number; effort?: number }): SharpImage
    toFile(path: string): Promise<unknown>
  }
  const sharp: (input: string) => SharpImage
  export default sharp
}
