// Fixed-timestep driver for the physics world. Pure timing logic (no Babylon), so it can be tested on its own.
//
// Why: stepping physics by the raw frame time makes a lag spike one giant step, which tunnels bodies through each other
// and blows the solver up. Instead every step is exactly `step` seconds, and real time is paid back as however many
// whole steps it owes. A lag spike therefore costs extra steps in the next frame (the game stays on real time and just
// looks choppy for a moment) rather than one huge step or lost time.

// Time owed is a running sum of floating-point frame times, so 96 frames of 1/60 s can total 95.99999... steps.
// Without a little slack that last step would be deferred to the next frame for no reason.
const SLACK = 1e-9;

export class FixedStepper {
  /**
   * step: seconds per physics step. maxBacklog: the most lag, in seconds, that is ever paid back (a tab left in the
   * background should not replay minutes of physics). budgetMs: real time one frame may spend stepping; if catching up
   * would take longer, the remaining backlog is dropped so the game slows down instead of freezing.
   */
  constructor({ step = 1 / 60, maxBacklog = 1, budgetMs = 14, now = () => performance.now() } = {}) {
    this.step = step;
    this.maxBacklog = maxBacklog;
    this.budgetMs = budgetMs;
    this.now = now;
    this.acc = 0;
  }

  reset() { this.acc = 0; }

  /** How far between the last step and the next one the clock is, 0 to 1. Used to interpolate what is drawn. */
  get alpha() { return this.acc / this.step; }

  /**
   * Adds dt seconds of real time and calls stepFn() once per whole step owed.
   * Returns { steps, dropped }: dropped is seconds of simulation given up because the budget ran out.
   */
  advance(dt, stepFn) {
    this.acc = Math.min(this.acc + Math.max(0, dt), this.maxBacklog);
    const start = this.now();
    let steps = 0, dropped = 0;
    while (this.acc >= this.step - SLACK) {
      stepFn();
      this.acc = Math.max(0, this.acc - this.step);
      steps++;
      if (this.acc >= this.step - SLACK && this.now() - start > this.budgetMs) {
        dropped = Math.floor(this.acc / this.step) * this.step;
        this.acc -= dropped;
        break;
      }
    }
    return { steps, dropped };
  }
}
