import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PublicKey } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import * as sdk from '@mgk/sdk';

import { config } from '@/lib/config';
import { OpenOrders } from './OpenOrders';

const USER = new PublicKey('2ecHahNv1LcVsmp614f8XTdpcTksNMwx7FkCJBtsMiQX');

const getMultipleAccountsInfo = vi.fn();
const sendTransaction = vi.fn();

vi.mock('@solana/wallet-adapter-react', () => ({
  useWallet: () => ({
    publicKey: USER,
    sendTransaction,
  }),
  useConnection: () => ({
    connection: {
      getMultipleAccountsInfo,
      confirmTransaction: vi.fn(),
    },
  }),
}));

function bookWithUserOrder(user: PublicKey): Buffer {
  const data = Buffer.alloc(
    sdk.state.RESTING_ORDERS_OFFSET +
      sdk.state.MAX_RESTING_ORDERS * sdk.state.RESTING_ORDER_SIZE,
  );
  data.writeUInt16LE(0, 0);
  data.writeBigInt64LE(150_000n, 8);
  data.writeBigInt64LE(150_000n, 16);
  data.writeUInt32LE(1, 24);
  data.writeBigUInt64LE(2n, 32);

  const orderOffset = sdk.state.BOOK_HEADER_SIZE;
  data.writeBigUInt64LE(1n, orderOffset);
  user.toBuffer().copy(data, orderOffset + 8);
  data.writeUInt8(1, orderOffset + 40);
  data.writeBigInt64LE(150_000n, orderOffset + 48);
  data.writeBigUInt64LE(100n, orderOffset + 56);
  data.writeBigUInt64LE(0n, orderOffset + 64);
  data.writeUInt16LE(0, orderOffset + 72);
  data.writeUInt8(0, orderOffset + 74);
  data.writeBigUInt64LE(11n, orderOffset + 80);
  data.writeUInt32LE(0xffffffff, orderOffset + 88);

  return data;
}

describe('OpenOrders', () => {
  it('reads the configured live book account and renders matching user orders', async () => {
    const onCountChange = vi.fn();
    getMultipleAccountsInfo.mockResolvedValue([
      {
        data: bookWithUserOrder(USER),
        executable: false,
        lamports: 1,
        owner: config.matcherProgramId,
      },
    ]);

    render(<OpenOrders instrumentId={0} onCountChange={onCountChange} />);

    await waitFor(() => {
      expect(getMultipleAccountsInfo).toHaveBeenCalledWith([config.bookAddress]);
    });
    expect(await screen.findByTestId('open-order-row')).toBeInTheDocument();
    expect(screen.getByTestId('open-order-price')).toHaveTextContent('0.15');
    expect(onCountChange).toHaveBeenCalledWith(1);
  });

  it('shows validation feedback instead of silently ignoring a zero modify quantity', async () => {
    getMultipleAccountsInfo.mockResolvedValue([
      {
        data: bookWithUserOrder(USER),
        executable: false,
        lamports: 1,
        owner: config.matcherProgramId,
      },
    ]);
    sendTransaction.mockReset();

    render(<OpenOrders instrumentId={0} />);

    await screen.findByTestId('open-order-row');
    fireEvent.click(screen.getByTestId('open-order-modify'));
    fireEvent.change(screen.getByTestId('open-order-modify-input'), {
      target: { value: '0' },
    });
    fireEvent.click(screen.getByTestId('open-order-modify-confirm'));

    expect(screen.getByTestId('open-order-modify-error')).toHaveTextContent(
      'Enter a quantity greater than 0.',
    );
    expect(sendTransaction).not.toHaveBeenCalled();
  });
});
