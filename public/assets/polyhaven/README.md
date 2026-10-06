# Poly Haven terrain materials

Imported 2026-10-06 directly from the official Poly Haven API/CDN. All nine runtime maps are unmodified **1024 × 1024 JPEGs**, totaling **5,304,440 bytes** (approximately 5.06 MiB transferred). They are local files; gameplay does not contact Poly Haven.

| Asset | Artist | Official physical width | Runtime use |
| --- | --- | --- | --- |
| [Aerial Grass Rock](https://polyhaven.com/a/aerial_grass_rock) | Rob Tuytel | 15 m | Ground cover; horizontal world-space projection |
| [Aerial Rocks 02](https://polyhaven.com/a/aerial_rocks_02) | Rob Tuytel | 50 m | Steep slopes and elevated rock; triplanar projection |
| [Aerial Sand](https://polyhaven.com/a/aerial_sand) | Rob Tuytel | 15 m | Low coastal terrain; horizontal world-space projection |

Each material includes diffuse/albedo (`diff`), OpenGL tangent-space normal (`nor_gl`), and packed ambient occlusion/roughness/metalness (`arm`: R/G/B). Albedo uses sRGB; normal and packed data maps remain linear. Terrain metalness remains zero. Nine mipmapped RGBA8 GPU textures require about 48 MiB, which is separate from compressed download size; low quality suppresses normal detail but does not unload texture maps.

## License and provenance

These asset files are **CC0-1.0**, allowing commercial use, modification and redistribution. [Official asset license](https://polyhaven.com/license), [CC0 legal terms](https://creativecommons.org/publicdomain/zero/1.0/legalcode). Attribution is retained voluntarily. Asset preview renders and Poly Haven logos were not downloaded.

`manifest.json` is the imported-byte roster: it records the exact provider URL, source asset page, bytes, provider MD5 and independently calculated SHA256 for every image. Provider MD5 values were checked before admission. Adjacent `*-files.json` and `*-info.json` preserve official API metadata used to select the maps and physical scales. This project-owned manifest is not a Game Development Studio CLI receipt.

The material system uses one shared `MeshStandardMaterial` across terrain patches, repeat wrapping, mipmaps and renderer-supported anisotropy capped at 8. It blends by geometric slope/elevation/coastal height, uses vertex biome colors only as subtle modulation, fades local normal detail with viewing distance and follows the floating origin with global coordinates. No displacement is applied, so terrain collision geometry is unchanged.

Known limits: grass/rock textures repeat at their source physical scales; biome blend thresholds are an art approximation rather than an erosion simulation. Texture download failure leaves a procedural-color placeholder and is exposed through `World.materialError`. The existing shader path targets WebGL2, not a WebGPU/TSL migration.

Run `npx tsx --test tests/polyhaven-assets.test.ts` to verify the complete SHA256/MD5 byte roster.
