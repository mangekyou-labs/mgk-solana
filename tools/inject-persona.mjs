import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { install, personaKeypairPath, loadEnvLocal } = require('./inject-persona.js');

export { install, personaKeypairPath, loadEnvLocal };
