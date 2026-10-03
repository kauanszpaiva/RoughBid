/** A lost bridge delivery asks SQL to reconcile its saved state. It never
 * authorizes another dispatch by itself. */
export class PhotoBridgeRecoveryError extends Error {
  constructor(){super('photo_bridge_delivery_pending');this.name='PhotoBridgeRecoveryError';}
}
export class PhotoBridgeOutcomeUnknownError extends Error {
  constructor(){super('photo_bridge_outcome_unknown');this.name='PhotoBridgeOutcomeUnknownError';}
}
