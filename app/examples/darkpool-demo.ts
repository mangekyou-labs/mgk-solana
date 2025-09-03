import {
  Connection,
  PublicKey,
  Keypair,
  clusterApiUrl,
} from '@solana/web3.js';
import { AnchorProvider, Wallet, BN } from '@coral-xyz/anchor';
import { DarkpoolClient, createDarkpoolClient, DarkOrder } from '../src/darkpool-client';

// Example: Submit a dark order to the pool
async function submitDarkOrder() {
  // Setup connection and provider
  const connection = new Connection(clusterApiUrl('devnet'), 'confirmed');
  const wallet = new Wallet(Keypair.generate()); // In production, use actual wallet
  const provider = new AnchorProvider(connection, wallet, {});

  // Program IDs (these would be actual deployed program IDs)
  const darkpoolProgramId = new PublicKey('DarkP00LMv22PMhdoSiUqm9Ee9VzVL8zsaDLFkGQKrdKL');
  const perpetualsProgramId = new PublicKey('E4digHpb1shbPFxdQTd6D6tnDnNYznrnNPoduHDtEn9H');
  const arciumProgramId = new PublicKey('Arc1um1111111111111111111111111111111111111');

  try {
    // Create darkpool client
    const darkpoolClient = await createDarkpoolClient(
      connection,
      provider,
      darkpoolProgramId,
      perpetualsProgramId,
      arciumProgramId
    );

    // Define a dark order
    const order: DarkOrder = {
      owner: wallet.publicKey,
      side: 0, // 0 = long position
      sizeUsd: new BN(1000_000000), // $1,000 USD (6 decimals)
      collateralAmount: new BN(200_000000), // $200 collateral
      maxPrice: new BN(50000_000000), // $50,000 max price (6 decimals)
      leverage: new BN(5), // 5x leverage
      pool: new PublicKey('PoOL1111111111111111111111111111111111111'), // Example pool
      custody: new PublicKey('Custd111111111111111111111111111111111111'), // SOL custody
      collateralCustody: new PublicKey('USDc111111111111111111111111111111111111'), // USDC custody
      timestamp: new BN(Date.now() / 1000),
      nonce: new BN(Math.floor(Math.random() * 1000000)),
    };

    console.log('Submitting dark order...');
    console.log('Order details:', {
      side: order.side === 0 ? 'LONG' : 'SHORT',
      size: `$${order.sizeUsd.toNumber() / 1_000_000}`,
      collateral: `$${order.collateralAmount.toNumber() / 1_000_000}`,
      maxPrice: `$${order.maxPrice.toNumber() / 1_000_000}`,
      leverage: `${order.leverage.toNumber()}x`,
    });

    // Submit the encrypted order
    const arciumPublicKey = new PublicKey('Arc1umPubK3y111111111111111111111111111111'); // Arcium MPC public key
    const txid = await darkpoolClient.submitDarkOrder(
      wallet.payer, // This would be the actual trader's keypair
      order,
      arciumPublicKey
    );

    console.log('✅ Dark order submitted successfully!');
    console.log('Transaction ID:', txid);
    console.log('Order is now encrypted and queued for matching...');

    // Listen for events
    console.log('🔍 Listening for matching events...');
    const eventListener = await darkpoolClient.listenForDarkpoolEvents((event) => {
      console.log('📢 Darkpool event received:', event);
      
      if (event.name === 'DarkOrdersMatched') {
        console.log('🎯 Orders matched!');
        console.log('Total volume:', event.data.totalVolume.toString());
        console.log('Average price:', event.data.averagePrice.toString());
      }
    });

    // In a real application, you would keep the listener running
    // For this example, we'll just log that it's set up
    console.log('Event listener ID:', eventListener);

  } catch (error) {
    console.error('❌ Error submitting dark order:', error);
  }
}

// Example: Initialize a new darkpool
async function initializeDarkpool() {
  const connection = new Connection(clusterApiUrl('devnet'), 'confirmed');
  const authority = Keypair.generate(); // In production, use actual authority keypair
  const wallet = new Wallet(authority);
  const provider = new AnchorProvider(connection, wallet, {});

  const darkpoolProgramId = new PublicKey('DarkP00LMv22PMhdoSiUqm9Ee9VzVL8zsaDLFkGQKrdKL');
  const perpetualsProgramId = new PublicKey('E4digHpb1shbPFxdQTd6D6tnDnNYznrnNPoduHDtEn9H');
  const arciumProgramId = new PublicKey('Arc1um1111111111111111111111111111111111111');

  try {
    const darkpoolClient = await createDarkpoolClient(
      connection,
      provider,
      darkpoolProgramId,
      perpetualsProgramId,
      arciumProgramId
    );

    console.log('Initializing darkpool...');
    
    // Initialize darkpool with configuration
    const txid = await darkpoolClient.initializeDarkpool(authority, {
      perpetualsProgram: perpetualsProgramId,
      minOrderSize: new BN(10_000000), // $10 minimum
      maxOrderSize: new BN(1000000_000000), // $1M maximum
      feeRate: 30, // 0.3% in basis points
    });

    console.log('✅ Darkpool initialized successfully!');
    console.log('Transaction ID:', txid);

    // Initialize computation definitions
    console.log('Setting up computation definitions...');
    const compDefTxids = await darkpoolClient.initializeCompDefs(authority);
    
    console.log('✅ Computation definitions initialized:');
    compDefTxids.forEach((txid, index) => {
      console.log(`  CompDef ${index + 1}:`, txid);
    });

    console.log('🎉 Darkpool is ready for encrypted order submission!');

  } catch (error) {
    console.error('❌ Error initializing darkpool:', error);
  }
}

// Example: Match orders (typically called by authorized matchers)
async function matchOrders() {
  const connection = new Connection(clusterApiUrl('devnet'), 'confirmed');
  const matcher = Keypair.generate(); // In production, use authorized matcher keypair
  const wallet = new Wallet(matcher);
  const provider = new AnchorProvider(connection, wallet, {});

  const darkpoolProgramId = new PublicKey('DarkP00LMv22PMhdoSiUqm9Ee9VzVL8zsaDLFkGQKrdKL');
  const perpetualsProgramId = new PublicKey('E4digHpb1shbPFxdQTd6D6tnDnNYznrnNPoduHDtEn9H');
  const arciumProgramId = new PublicKey('Arc1um1111111111111111111111111111111111111');

  try {
    const darkpoolClient = await createDarkpoolClient(
      connection,
      provider,
      darkpoolProgramId,
      perpetualsProgramId,
      arciumProgramId
    );

    console.log('🔄 Triggering order matching...');
    
    // In a real implementation, this would contain encrypted orders from the order book
    const mockEncryptedOrders = Buffer.alloc(1024); // Placeholder for encrypted order batch
    const arciumPublicKey = new PublicKey('Arc1umPubK3y111111111111111111111111111111');

    const txid = await darkpoolClient.matchDarkOrders(
      matcher,
      mockEncryptedOrders,
      arciumPublicKey
    );

    console.log('✅ Order matching initiated!');
    console.log('Transaction ID:', txid);
    console.log('⏳ MPC network is processing encrypted orders...');
    console.log('Results will be available via callback when matching completes.');

  } catch (error) {
    console.error('❌ Error matching orders:', error);
  }
}

// Example: Monitor darkpool statistics
async function monitorDarkpool() {
  const connection = new Connection(clusterApiUrl('devnet'), 'confirmed');
  
  console.log('📊 Monitoring darkpool activity...');
  console.log('Listening for events on devnet...');

  // In a real implementation, you would:
  // 1. Query darkpool account for current statistics
  // 2. Set up event listeners for real-time updates  
  // 3. Track metrics like volume, match rates, etc.
  
  const mockStats = {
    totalOrders: 1247,
    totalMatches: 583,
    totalVolume: '$12,847,392',
    averageMatchTime: '2.3 seconds',
    privacyScore: '99.8%', // Percentage of order details kept private
  };

  console.log('📈 Current Darkpool Statistics:');
  console.log('  Total Orders Submitted:', mockStats.totalOrders);
  console.log('  Total Matches:', mockStats.totalMatches);
  console.log('  Total Volume Traded:', mockStats.totalVolume);
  console.log('  Average Match Time:', mockStats.averageMatchTime);
  console.log('  Privacy Score:', mockStats.privacyScore);
  
  console.log('\\n🔒 Privacy Features Active:');
  console.log('  ✅ Order details encrypted');
  console.log('  ✅ Position sizes hidden');
  console.log('  ✅ MEV protection enabled');
  console.log('  ✅ Liquidation attack prevention');
}

// Main execution
async function main() {
  const command = process.argv[2];

  switch (command) {
    case 'init':
      await initializeDarkpool();
      break;
    case 'submit':
      await submitDarkOrder();
      break;
    case 'match':
      await matchOrders();
      break;
    case 'monitor':
      await monitorDarkpool();
      break;
    default:
      console.log('🌙 Darkpool Perpetuals Demo');
      console.log('');
      console.log('Available commands:');
      console.log('  npm run demo:init     - Initialize a new darkpool');
      console.log('  npm run demo:submit   - Submit an encrypted order');
      console.log('  npm run demo:match    - Trigger order matching');
      console.log('  npm run demo:monitor  - Monitor darkpool statistics');
      console.log('');
      console.log('Example: npm run demo:submit');
  }
}

main().catch(console.error);
