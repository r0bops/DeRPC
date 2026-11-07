// Node-only build/check adapter. A process uses one compilation of the reviewed local source.
import { registrarBuild } from '../../contracts/scripts/ens-plan.mjs';
import { browserOperatorBuild } from './ens-operator.ts';

let cached;
export function operatorBuild() {
  return cached ??= browserOperatorBuild(registrarBuild());
}
