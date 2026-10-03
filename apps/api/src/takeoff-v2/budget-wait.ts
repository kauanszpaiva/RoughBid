import type { DeepPassRequest } from './types.ts';

export class FullTakeoffRunBudgetExhausted extends Error {
  constructor() { super('This reading reached its approved total budget.'); this.name='FullTakeoffRunBudgetExhausted'; }
}

/** Only a recorded, pre-dispatch company denial can create this suspension. */
export class FullTakeoffBudgetWait extends Error {
  readonly request: DeepPassRequest;
  readonly eventId: string;
  constructor(request: DeepPassRequest, eventId: string) {
    super('Full reading is waiting for company processing capacity.');
    this.request = request; this.eventId = eventId;
    this.name = 'FullTakeoffBudgetWait';
  }
}
