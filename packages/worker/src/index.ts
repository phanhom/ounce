export { startWorker } from "./main.js";
export type { WorkerConfig } from "./config.js";
export { ensureKeyPair, computeFingerprint, verifySignature, getPublicKeyPath, getPrivateKeyPath } from "./keygen.js";
export type { WorkerKeyPair } from "./keygen.js";
export { WorkerBeacon, WORKER_BEACON_PORT } from "./beacon.js";
export type { BeaconInfo, PairChallengeRequest, PairChallengeResponse, PairResult } from "./beacon.js";
