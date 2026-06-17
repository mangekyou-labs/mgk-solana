import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TxToast } from './TxToast';

describe('TxToast', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders a confirmed state when error is null', () => {
    render(
      <TxToast
        signature="5Sig111111111111111111111111111111111111111111111111111111111111"
        error={null}
      />,
    );
    expect(screen.getByTestId('tx-toast-status')).toHaveTextContent(
      'Transaction Confirmed',
    );
    expect(screen.getByTestId('tx-toast').getAttribute('data-error')).toBe('false');
  });

  it('renders a failed state when error is provided', () => {
    render(
      <TxToast
        signature="5Sig222222222222222222222222222222222222222222222222222222222222"
        error="User rejected the request"
      />,
    );
    expect(screen.getByTestId('tx-toast-status')).toHaveTextContent(
      'Transaction Failed',
    );
    expect(screen.getByTestId('tx-toast').getAttribute('data-error')).toBe('true');
  });

  it('renders the humanized program error for custom program errors', () => {
    render(
      <TxToast
        signature="5Sig333333333333333333333333333333333333333333333333333333333333"
        error="failed to send transaction: Transaction simulation failed: Error processing Instruction 0: custom program error: 0x0"
      />,
    );
    expect(screen.getByTestId('tx-toast-error')).toHaveTextContent(
      'The transaction was malformed. Please try again.',
    );
  });

  it('renders raw error when code extraction fails', () => {
    render(
      <TxToast
        signature="sig"
        error="Something went wrong"
      />,
    );
    expect(screen.getByTestId('tx-toast-error')).toHaveTextContent(
      'Something went wrong',
    );
  });

  it('renders the explorer link with shortened signature', () => {
    render(
      <TxToast
        signature="abc1234567890xyz1234567890abcz1234567890xyz12345678901234567890"
        error={null}
      />,
    );
    const link = screen.getByTestId('tx-toast-explorer');
    expect(link).toHaveTextContent('abc12345…34567890');
    expect(link.getAttribute('href')).toContain('explorer.solana.com');
    expect(link.getAttribute('href')).toContain('devnet');
  });

  it('renders retry button when error and onRetry are present', () => {
    const onRetry = vi.fn();
    render(
      <TxToast
        signature="sig"
        error="Something went wrong"
        onRetry={onRetry}
      />,
    );
    const retry = screen.getByTestId('tx-toast-retry');
    expect(retry).toBeInTheDocument();
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('hides retry button when there is no error', () => {
    render(
      <TxToast
        signature="sig"
        error={null}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('tx-toast-retry')).toBeNull();
  });

  it('calls onDismiss when dismiss button is clicked', () => {
    const onDismiss = vi.fn();
    render(
      <TxToast
        signature="sig"
        error={null}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByTestId('tx-toast-dismiss'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('applies className to the root', () => {
    const { container } = render(
      <TxToast
        signature="sig"
        error={null}
        className="custom-class"
      />,
    );
    expect(container.firstChild).toHaveClass('custom-class');
  });
});
