# web

DeRPC site and operator directory. Vanilla TypeScript + Vite, Inter (self-hosted via
`@fontsource-variable/inter`), hash routing so it also loads from IPFS and `derpc.eth.limo`.

```
pnpm --filter web dev
pnpm --filter web build
```

Pages: `#/` landing, `#/directory` (by operator or by network, shareable as
`#/directory?by=networks&q=base&verified=1`), `#/network/:id`, `#/operator/:ens`, `#/operate`.

## What is real

- `src/directory/operators.ts` lists the five operators from `provider/src/config` and the networks
  each one says it serves. Every network entry has a source link to the operator's own documentation.
- Only Ethereum mainnet (chain ID 1) is verified by DeRPC. Other networks are listed, labeled
  "not verified", and never marked as tested. `validateDirectory` in `src/directory/model.ts`
  enforces this.
- `provider/test/config/directory-sync.test.ts` fails if the directory and the provider's operator
  list drift apart.
- ENS names are mock (`ENS_NAMES_ARE_MOCK` in the provider) and are badged as such.
- The `/operate` page describes the planned registry and staking and is labeled as roadmap.

Brand assets are in `/brand`: Inter, lime, ink and white are primary; cobalt is secondary (never in the logo).
