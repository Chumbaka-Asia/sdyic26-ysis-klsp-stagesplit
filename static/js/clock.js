// A show clock that stops while the show is paused.
// Everything timed in the show (placeholder cards, answer windows, hold timers)
// reads clock.now() instead of performance.now(), so pausing freezes it all.

export const clock = {
  paused: false,
  _offset: 0,
  _pausedAt: 0,

  now() {
    return (this.paused ? this._pausedAt : performance.now()) - this._offset;
  },
  pause() {
    if (this.paused) return;
    this.paused = true;
    this._pausedAt = performance.now();
  },
  resume() {
    if (!this.paused) return;
    this._offset += performance.now() - this._pausedAt;
    this.paused = false;
  },
};
