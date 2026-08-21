import type { LiveBook } from "@dreamdex-bot-kit/lucid-core";

export function OrderBook({ book }: { book: LiveBook }) {
  const bids = book.yesBids.slice(0, 5);
  const asks = book.yesAsks.slice(0, 5).slice().reverse();
  const maxQty = Math.max(1, ...bids.map((b) => b.quantity), ...asks.map((a) => a.quantity));

  return (
    <div className="panel" data-testid="order-book">
      <h2 className="section-title">Order book, YES</h2>
      <div className="book-ladder">
        <div className="book-side">
          {asks.length === 0 && <div className="book-empty">no resting asks</div>}
          {asks.map((a) => (
            <div className="book-level ask" key={`ask-${a.price}`}>
              <span className="book-depth-bar ask" style={{ width: `${(a.quantity / maxQty) * 100}%` }} />
              <span className="book-price">{a.price.toFixed(3)}</span>
              <span className="book-qty">{a.quantity.toFixed(2)}</span>
            </div>
          ))}
        </div>
        <div className="book-spread">
          {book.bestBid !== undefined && book.bestAsk !== undefined ? (
            <span>spread {(book.bestAsk - book.bestBid).toFixed(3)}</span>
          ) : (
            <span>one-sided</span>
          )}
        </div>
        <div className="book-side">
          {bids.length === 0 && <div className="book-empty">no resting bids</div>}
          {bids.map((b) => (
            <div className="book-level bid" key={`bid-${b.price}`}>
              <span className="book-depth-bar bid" style={{ width: `${(b.quantity / maxQty) * 100}%` }} />
              <span className="book-price">{b.price.toFixed(3)}</span>
              <span className="book-qty">{b.quantity.toFixed(2)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
