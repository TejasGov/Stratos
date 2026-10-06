import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

test("vendored Poly Haven terrain maps match their complete CC0 integrity roster", async () => {
  const directory = new URL("../public/assets/polyhaven/", import.meta.url);
  const manifest = JSON.parse(
    await readFile(new URL("manifest.json", directory), "utf8"),
  );
  assert.equal(manifest.license, "CC0-1.0");
  assert.equal(manifest.files.length, 9);
  assert.equal(
    new Set(manifest.files.map((entry: { path: string }) => entry.path)).size,
    9,
  );
  let bytes = 0;
  for (const entry of manifest.files) {
    assert.match(entry.path, /^[a-z0-9_]+\.jpg$/);
    assert.equal(new URL(entry.source).hostname, "dl.polyhaven.org");
    const image = await readFile(new URL(entry.path, directory));
    assert.equal(image.byteLength, entry.bytes);
    assert.equal(
      createHash("sha256").update(image).digest("hex"),
      entry.sha256,
    );
    assert.equal(
      createHash("md5").update(image).digest("hex"),
      entry.providerMd5,
    );
    assert.equal(image[0], 0xff);
    assert.equal(image[1], 0xd8);
    bytes += image.byteLength;
  }
  assert.equal(bytes, 5304440);
});
