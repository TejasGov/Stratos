import { buildTerrain } from "./terrain";
self.onmessage = (
  event: MessageEvent<{
    key: string;
    x: number;
    z: number;
    segments: number;
    requestId: number;
  }>,
) => {
  const { key, x, z, segments, requestId } = event.data;
  const data = buildTerrain(x, z, segments);
  self.postMessage(
    { key, x, z, segments, requestId, ...data },
    {
      transfer: [
        data.positions.buffer,
        data.normals.buffer,
        data.colors.buffer,
        data.indices.buffer,
      ],
    },
  );
};
