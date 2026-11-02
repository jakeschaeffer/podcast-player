/** Thrown by a job body to park the job until something outside the queue wakes it (a transcript, a budget, a missing adapter). */
export class DeferJob extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeferJob";
  }
}

/** Thrown by a job body for failures that retrying will not fix. */
export class NonRetryable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryable";
  }
}
