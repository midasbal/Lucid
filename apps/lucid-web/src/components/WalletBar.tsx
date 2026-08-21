import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { somniaShannon } from "../lib/chain";

function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function WalletBar() {
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending: connecting, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();

  const wrongNetwork = isConnected && chainId !== somniaShannon.id;

  if (!isConnected) {
    const injected = connectors.find((c) => c.id === "injected") ?? connectors[0];
    return (
      <div className="wallet-bar">
        <button
          className="btn btn-accent"
          data-testid="connect-wallet"
          disabled={!injected || connecting}
          onClick={() => injected && connect({ connector: injected, chainId: somniaShannon.id })}
        >
          {connecting ? "connecting…" : "connect wallet"}
        </button>
        {connectError && <span className="disclaimer">{connectError.message.split("\n")[0]}</span>}
      </div>
    );
  }

  if (wrongNetwork) {
    return (
      <div className="wallet-bar">
        <span className="addr-pill">{short(address!)}</span>
        <button
          className="btn btn-warn"
          data-testid="switch-network"
          disabled={switching}
          onClick={() => switchChain({ chainId: somniaShannon.id })}
        >
          {switching ? "switching…" : "switch to Somnia Shannon"}
        </button>
      </div>
    );
  }

  return (
    <div className="wallet-bar">
      <span className="net-pill">
        <span className="dot" /> Shannon
      </span>
      <span className="addr-pill" data-testid="wallet-address">
        {short(address!)}
      </span>
      <button className="btn" onClick={() => disconnect()}>
        disconnect
      </button>
    </div>
  );
}
