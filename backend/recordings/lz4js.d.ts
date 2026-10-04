declare const lz4: { decompress(bytes: Uint8Array): ArrayLike<number>; compress(bytes: Uint8Array): ArrayLike<number> }
export default lz4
