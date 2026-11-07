/** Public deployment pins only. Shared by the build, browser and offline release checker. */
export interface EnsDirectoryConfig {
  chainId: 1;
  ethRegistry: `0x${string}`;
  registrar: {
    address: `0x${string}`;
    codeHash: `0x${string}`;
    registry: `0x${string}`;
  };
}

/** Empty/unset is deliberately unconfigured; a supplied but invalid pin must never fall back. */
export function parseEnsDirectory(input: string | undefined): EnsDirectoryConfig | null {
  if (input === undefined || input.trim() === "") return null;
  const fail = () => new Error("VITE_ENS_DIRECTORY must contain mainnet chainId 1, ethRegistry and registrar { address, codeHash, registry } with nonzero deployment pins.");
  let value: unknown;
  try { value = JSON.parse(input); } catch { throw fail(); }
  const object = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
  const hex = (value: unknown, digits: number): value is `0x${string}` =>
    typeof value === "string" && new RegExp(`^0x[0-9a-fA-F]{${digits}}$`).test(value) && !/^0x0+$/i.test(value);
  if (!object(value, ["chainId", "ethRegistry", "registrar"]) || value.chainId !== 1 ||
      !hex(value.ethRegistry, 40) || !object(value.registrar, ["address", "codeHash", "registry"]) ||
      !hex(value.registrar.address, 40) || !hex(value.registrar.codeHash, 64) || !hex(value.registrar.registry, 40)) throw fail();
  // Fixed field order and lowercase hexadecimal keep the runtime and emitted asset identical.
  return {
    chainId: 1,
    ethRegistry: value.ethRegistry.toLowerCase() as `0x${string}`,
    registrar: {
      address: value.registrar.address.toLowerCase() as `0x${string}`,
      codeHash: value.registrar.codeHash.toLowerCase() as `0x${string}`,
      registry: value.registrar.registry.toLowerCase() as `0x${string}`,
    },
  };
}
