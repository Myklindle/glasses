// Chapter ("story") math, kept separate from the page so it can be tested in Node.
(function (root) {
  'use strict';

  // Keep only well-formed chapters, in time order.
  function clean(list) {
    if (!Array.isArray(list)) return [];
    return list
      .filter((c) => c && Number.isFinite(c.start) && c.start >= 0 && typeof c.title === 'string')
      .sort((a, b) => a.start - b.start);
  }

  // Index of the chapter containing time t (seconds), or -1 before the first one.
  function indexAt(chapters, t) {
    let idx = -1;
    for (let i = 0; i < chapters.length; i++) {
      if (chapters[i].start <= t + 0.5) idx = i; else break;
    }
    return idx;
  }

  // Where Next story goes from chapter i, or -1 when already on the last one.
  function nextIndex(chapters, i) {
    return i + 1 < chapters.length ? i + 1 : -1;
  }

  // Where Prev story goes: restart this chapter if more than 5 s in, else the one before.
  function prevIndex(chapters, i, secondsIn) {
    if (i >= 0 && secondsIn > 5) return i;
    return Math.max(0, i - 1);
  }

  const api = { clean, indexAt, nextIndex, prevIndex };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Chapters = api;
})(typeof window !== 'undefined' ? window : this);
