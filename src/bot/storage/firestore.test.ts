import { FirestoreStorage } from './firestore.js';
import { transactionRow } from '../../utils/tests.js';
import { TransactionStatuses } from 'israeli-bank-scrapers/lib/transactions.js';

const mockBatch = {
  set: jest.fn(),
  commit: jest.fn().mockResolvedValue(undefined),
};
const mockDocRef = {};
const mockDb = {
  collection: jest.fn().mockReturnValue({
    doc: jest.fn().mockReturnValue(mockDocRef),
  }),
  getAll: jest.fn().mockResolvedValue([{ exists: false }]),
  batch: jest.fn().mockReturnValue(mockBatch),
};

jest.mock('firebase-admin/firestore', () => ({
  getFirestore: jest.fn(() => mockDb),
  FieldValue: { serverTimestamp: jest.fn().mockReturnValue('TIMESTAMP') },
}));

jest.mock('../../utils/logger.js', () => ({
  createLogger: () => jest.fn(),
}));

jest.mock('../saveStats.js', () => ({
  createSaveStats: jest.fn().mockReturnValue({ added: 0, existing: 0, name: 'Firestore' }),
}));

describe('FirestoreStorage', () => {
  const uid = 'user-abc-123';

  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.getAll.mockResolvedValue([{ exists: false }]);
  });

  it('writes transactions to users/{uid}/transactions collection', async () => {
    const storage = new FirestoreStorage(uid);
    const tx = transactionRow({ status: TransactionStatuses.Completed });
    await storage.saveTransactions([tx], async () => {});
    expect(mockDb.collection).toHaveBeenCalledWith(`users/${uid}/transactions`);
  });

  it('canSave returns true when FIREBASE_CONFIG is set', () => {
    process.env.FIREBASE_CONFIG = '{}';
    const storage = new FirestoreStorage(uid);
    expect(storage.canSave()).toBe(true);
    delete process.env.FIREBASE_CONFIG;
  });
});
