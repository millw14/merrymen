declare module "snarkjs" {
  export const groth16: {
    fullProve(
      input: Record<string, string | string[]>,
      wasm: Uint8Array,
      zkey: Uint8Array,
    ): Promise<{
      proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] };
      publicSignals: string[];
    }>;
  };
}
