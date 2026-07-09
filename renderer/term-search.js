// term-search.js — the Cmd+F find-in-terminal overlay. Owns the search bar DOM
// and its listeners, and drives the active terminal's xterm SearchAddon.
//
// FACTORY (R2): search operates on the active terminal, so `sessions` (the live
// Map) and getActiveSession (activeSession is a reassignable let) come in as
// factory params — the only cross-island reach-ins. Returns the handles
// renderer.js still calls: openSearch (Cmd+F), closeSearch + isSearchOpen (the
// switch-session teardown), and setSearchInfo (createSession's SearchAddon
// onDidChangeResults callback writes the match counter through it).
//
// DOM-bound, so no unit tests per the R1 rule — move-only fidelity is the
// guarantee.

function createTermSearch({ sessions, getActiveSession }) {
  const searchBar = document.getElementById('search-bar');
  const searchInput = document.getElementById('search-input');
  const searchInfo = document.getElementById('search-info');
  const searchPrev = document.getElementById('search-prev');
  const searchNext = document.getElementById('search-next');
  const searchClose = document.getElementById('search-close');

  const SEARCH_OPTS = {
    decorations: {
      matchBackground: '#e94560',
      matchBorder: '#e94560',
      matchOverviewRuler: '#e94560',
      activeMatchBackground: '#fbbf24',
      activeMatchBorder: '#fbbf24',
      activeMatchColorOverviewRuler: '#fbbf24',
    },
  };

  function openSearch() {
    searchBar.classList.remove('hidden');
    searchInput.focus();
    searchInput.select();
  }

  function closeSearch() {
    searchBar.classList.add('hidden');
    searchInfo.textContent = '';
    if (getActiveSession()) {
      const s = sessions.get(getActiveSession());
      if (s && s.searchAddon) s.searchAddon.clearDecorations();
      if (s) s.terminal.focus();
    }
  }

  function findInTerminal(direction = 'next') {
    if (!getActiveSession()) return;
    const s = sessions.get(getActiveSession());
    if (!s || !s.searchAddon) return;
    const term = searchInput.value;
    if (!term) {
      s.searchAddon.clearDecorations();
      searchInfo.textContent = '';
      return;
    }
    const method = direction === 'prev' ? 'findPrevious' : 'findNext';
    s.searchAddon[method](term, SEARCH_OPTS);
  }

  searchInput.addEventListener('input', () => findInTerminal('next'));
  searchInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') findInTerminal(e.shiftKey ? 'prev' : 'next');
    if (e.key === 'Escape') closeSearch();
  });
  searchPrev.addEventListener('click', () => findInTerminal('prev'));
  searchNext.addEventListener('click', () => findInTerminal('next'));
  searchClose.addEventListener('click', closeSearch);

  // Handles renderer.js still needs. isSearchOpen/setSearchInfo replace the two
  // spots that reached the island's DOM directly (switch-session teardown and
  // the per-terminal result callback).
  const isSearchOpen = () => !searchBar.classList.contains('hidden');
  const setSearchInfo = (text) => { searchInfo.textContent = text; };
  return { openSearch, closeSearch, findInTerminal, isSearchOpen, setSearchInfo };
}

module.exports = { createTermSearch };
