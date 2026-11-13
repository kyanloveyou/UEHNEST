# Module 9 — hướng dẫn triển khai
1. `firebase deploy --only functions` (cần gói Blaze — điểm chặn B01), `firestore:rules`, `storage`, `firestore:indexes`.
2. Cập nhật Storage bucket đang dùng: `khaidayy-hub.firebasestorage.app`.
3. Bật khóa kdCoins CHỈ sau cùng: đặt `lockCoins()` = true trong firestore.rules và
   `window.KDX_M9_FLAGS = { interceptLegacyReward: true }` trước khối Module 9 trong HTML.
4. Rollback: xóa khối "KDX · MODULE 9" trong HTML; `firebase functions:delete` các hàm m9_*.
