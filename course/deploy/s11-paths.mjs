import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const stagesRoot = path.resolve(process.env.CONTAINER_STAGES_DIR || fileURLToPath(new URL('../../stages/', import.meta.url)));
export const s11Root = path.join(stagesRoot, 's11-model-gateway');
export const courseRoot = path.resolve(process.env.COURSE_ROOT || fileURLToPath(new URL('../', import.meta.url)));
