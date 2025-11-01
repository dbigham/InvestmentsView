import PropTypes from 'prop-types';
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatDate, formatDateTime } from '../utils/formatters';

function normalizeArticles(articles) {
  if (!Array.isArray(articles)) {
    return [];
  }
  return articles
    .map((article) => {
      if (!article || typeof article !== 'object') {
        return null;
      }
      const title = typeof article.title === 'string' ? article.title.trim() : '';
      const url = typeof article.url === 'string' ? article.url.trim() : '';
      if (!title || !url) {
        return null;
      }
      const summary = typeof article.summary === 'string' ? article.summary.trim() : '';
      const source = typeof article.source === 'string' ? article.source.trim() : '';
      const publishedAt = typeof article.publishedAt === 'string' ? article.publishedAt.trim() : '';
      return {
        title,
        url,
        summary: summary || null,
        source: source || null,
        publishedAt: publishedAt || null,
      };
    })
    .filter(Boolean);
}

export default function PortfolioNews({
  status,
  articles,
  error,
  onRetry,
  disclaimer,
  generatedAt,
  symbols,
  accountLabel,
  onSeePrompt,
  prompt,
}) {
  const [contextMenuState, setContextMenuState] = useState({ open: false, x: 0, y: 0 });
  const menuRef = useRef(null);

  const normalizedStatus = status === 'idle' ? 'loading' : status;
  const safeArticles = normalizeArticles(articles);
  const showRetry = typeof onRetry === 'function' && normalizedStatus === 'error';
  const showEmpty = normalizedStatus === 'ready' && !safeArticles.length && !error;
  const timestampLabel = generatedAt ? formatDateTime(generatedAt) : null;
  const normalizedSymbols = Array.isArray(symbols)
    ? symbols
        .map((symbol) => (typeof symbol === 'string' ? symbol.trim().toUpperCase() : ''))
        .filter(Boolean)
    : [];
  const symbolLabel = normalizedSymbols.length ? normalizedSymbols.join(' • ') : null;
  const hasSymbols = normalizedSymbols.length > 0;
  const ariaLive = normalizedStatus === 'loading' ? 'polite' : 'off';
  const emptyMessage = hasSymbols
    ? 'No recent articles matched the current holdings.'
    : 'Add holdings to this account to surface relevant news.';

  const closeContextMenu = useCallback(() => {
    setContextMenuState((state) => (state.open ? { ...state, open: false } : state));
  }, []);

  const handleTitleContextMenu = useCallback((event) => {
    event.preventDefault();
    setContextMenuState({ open: true, x: event.clientX, y: event.clientY });
  }, []);

  useEffect(() => {
    if (!contextMenuState.open) {
      return undefined;
    }
    const handlePointer = (event) => {
      if (!menuRef.current) {
        closeContextMenu();
        return;
      }
      if (menuRef.current.contains(event.target)) {
        return;
      }
      closeContextMenu();
    };
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        closeContextMenu();
      }
    };
    const handleViewportChange = () => {
      closeContextMenu();
    };
    document.addEventListener('mousedown', handlePointer);
    document.addEventListener('touchstart', handlePointer);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);
    return () => {
      document.removeEventListener('mousedown', handlePointer);
      document.removeEventListener('touchstart', handlePointer);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [closeContextMenu, contextMenuState.open]);

  useEffect(() => {
    if (!contextMenuState.open || !menuRef.current) {
      return;
    }
    const { innerWidth, innerHeight } = window;
    const rect = menuRef.current.getBoundingClientRect();
    const padding = 12;
    let nextX = contextMenuState.x;
    let nextY = contextMenuState.y;
    if (nextX + rect.width > innerWidth - padding) {
      nextX = Math.max(padding, innerWidth - rect.width - padding);
    }
    if (nextY + rect.height > innerHeight - padding) {
      nextY = Math.max(padding, innerHeight - rect.height - padding);
    }
    if (nextX !== contextMenuState.x || nextY !== contextMenuState.y) {
      setContextMenuState((state) => (state.open ? { ...state, x: nextX, y: nextY } : state));
    }
  }, [contextMenuState.open, contextMenuState.x, contextMenuState.y]);

  useEffect(() => {
    if (!contextMenuState.open || !menuRef.current) {
      return;
    }
    const firstButton = menuRef.current.querySelector('button');
    if (firstButton && typeof firstButton.focus === 'function') {
      firstButton.focus({ preventScroll: true });
    }
  }, [contextMenuState.open]);

  return (
    <section className="news-panel" aria-live={ariaLive}>
      <header className="news-panel__header">
        <h3 className="news-panel__title" onContextMenu={handleTitleContextMenu}>Latest news</h3>
        {accountLabel ? <span className="news-panel__context">For {accountLabel}</span> : null}
        {symbolLabel ? <span className="news-panel__symbols">{symbolLabel}</span> : null}
        {timestampLabel ? <span className="news-panel__timestamp">Updated {timestampLabel}</span> : null}
      </header>

      {normalizedStatus === 'loading' ? (
        <div className="news-panel__status" role="status">
          Loading portfolio news…
        </div>
      ) : null}

      {normalizedStatus === 'error' ? (
        <div className="news-panel__error" role="alert">
          <p className="news-panel__error-text">
            Failed to load news{error ? `: ${error}` : ''}
          </p>
          {showRetry ? (
            <button type="button" className="news-panel__retry" onClick={onRetry}>
              Try again
            </button>
          ) : null}
        </div>
      ) : null}

      {safeArticles.length ? (
        <ul className="news-panel__list">
          {safeArticles.map((article, index) => {
            const metaParts = [];
            if (article.source) {
              metaParts.push(article.source);
            }
            if (article.publishedAt) {
              metaParts.push(formatDate(article.publishedAt));
            }
            const key = `${article.url}-${index}`;
            return (
              <li key={key} className="news-panel__item">
                <h4 className="news-panel__item-title">
                  <a href={article.url} target="_blank" rel="noreferrer">
                    {article.title}
                  </a>
                </h4>
                {metaParts.length ? (
                  <div className="news-panel__item-meta">{metaParts.join(' • ')}</div>
                ) : null}
                {article.summary ? <p className="news-panel__item-summary">{article.summary}</p> : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {showEmpty ? <p className="news-panel__empty">{emptyMessage}</p> : null}

      {disclaimer ? <p className="news-panel__disclaimer">{disclaimer}</p> : null}

      {contextMenuState.open ? (
        <div
          ref={menuRef}
          className="positions-table__context-menu"
          style={{ position: 'fixed', left: contextMenuState.x, top: contextMenuState.y }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <ul className="positions-table__context-menu-list" role="menu">
            <li>
              <button
                type="button"
                className="positions-table__context-menu-item"
                onClick={() => {
                  closeContextMenu();
                  if (typeof onSeePrompt === 'function') {
                    onSeePrompt();
                  }
                }}
                disabled={!prompt}
                role="menuitem"
              >
                See prompt
              </button>
            </li>
          </ul>
        </div>
      ) : null}
    </section>
  );
}

const articleShape = PropTypes.shape({
  title: PropTypes.string.isRequired,
  url: PropTypes.string.isRequired,
  summary: PropTypes.string,
  source: PropTypes.string,
  publishedAt: PropTypes.string,
});

PortfolioNews.propTypes = {
  status: PropTypes.oneOf(['idle', 'loading', 'ready', 'error']),
  articles: PropTypes.arrayOf(articleShape),
  error: PropTypes.string,
  onRetry: PropTypes.func,
  disclaimer: PropTypes.string,
  generatedAt: PropTypes.string,
  symbols: PropTypes.arrayOf(PropTypes.string),
  accountLabel: PropTypes.string,
  onSeePrompt: PropTypes.func,
  prompt: PropTypes.string,
};

PortfolioNews.defaultProps = {
  status: 'idle',
  articles: [],
  error: null,
  onRetry: null,
  disclaimer: null,
  generatedAt: null,
  symbols: [],
  accountLabel: '',
  onSeePrompt: null,
  prompt: null,
};
