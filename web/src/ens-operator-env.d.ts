declare module "virtual:derpc-ens-operator" {
  // Shared administrative JavaScript validates these objects before using them.
  const config: {
    deployment: any | null;
    build: any;
    adminRpcUrls: readonly [string, string];
  };
  export default config;
}
