/**
 * UEHNEST · MODULE 9 — Cloud Functions (onCall Gen 2, Node 20, asia-southeast1)
 * Nguồn ghi DUY NHẤT cho: duyệt đơn, nhận bài, gắn nhãn, cộng KD (15/bài, trần 60/ngày giờ VN),
 * báo cáo, phúc tra. Client không được tự ghi kdCoins / m9Badge / contentVersion / sổ cái.
 * Chỉ dùng đúng 6 đường dẫn dữ liệu M9 (Quyết định COO #11).
 */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
admin.initializeApp();
const db = admin.firestore();
const FV = admin.firestore.FieldValue;

const M9_CONFIG = {
  APP_ID: process.env.M9_APP_ID || '1:391963324847:web:0f2a0f49af7710f67a3f5a',
  MAIN_ADMIN: 'khaianhxuanai',
  MIN_GPA: 8.0,
  REPORT_THRESHOLD_N: 3,            // B05: mặc định đề xuất, chờ Sếp chốt
  DAILY_CAP_KD: 60,
  REWARD_PER_DOC: 15,
  LEGACY_DOC_REWARD: 20,
  MIN_REVIEWERS_PER_SUBJECT: 1,
  WRONG_PENALTY_ENABLED: false,     // B06: thu hồi 15 KD + tự đình chỉ — CHỜ Sếp chốt, mặc định TẮT
  AUTO_SUSPEND_RATE: 0.2
};
const OPT = { region: 'asia-southeast1', cors: true };

/* ── tiện ích ── */
const path = (col, id) => `artifacts/${M9_CONFIG.APP_ID}/public/data/${col}${id ? '/' + id : ''}`;
const D = (col, id) => db.doc(path(col, id));
const C = col => db.collection(path(col));
const userInfo = uid => db.doc(`artifacts/${M9_CONFIG.APP_ID}/users/${uid}/profile/info`);
const proofDoc = id => db.doc(`artifacts/${M9_CONFIG.APP_ID}/private/m5/reviewer_proofs/${id}`);
const subjectCode = s => String(s || '').trim().replace(/[\/.\s]+/g, '_');
const verOf = d => Number(d && d.contentVersion) || 1;
const dateVN = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);   // Asia/Ho_Chi_Minh (UTC+7)
const rate = st => (st.confirmedWrongVersionsCount || 0) / Math.max(1, st.totalVerifiedVersions || 0);   // COO #8: KHÔNG dùng falseReportRate

/* Vai trò: web KHÔNG lưu role trong profile/info — main_admin = username "khaianhxuanai",
   còn lại lấy từ tempAdmins/{username} còn hạn. username = phần trước @ của email đăng nhập. */
async function roleOf(req) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Cần đăng nhập.');
  const uname = String((req.auth.token.email || '').split('@')[0]).toLowerCase();
  if (uname === M9_CONFIG.MAIN_ADMIN) return { role: 'main_admin', uname };
  const s = uname ? await D('tempAdmins', uname).get() : null;
  if (s && s.exists && s.data().expiresAt > Date.now() && ['mod', 'admin'].includes(s.data().role)) return { role: s.data().role, uname };
  return { role: 'user', uname };
}
const needMain = async req => { const r = await roleOf(req); if (r.role !== 'main_admin') throw new HttpsError('permission-denied', 'Chỉ Admin chính.'); return r; };
const need = (c, msg, code) => { if (!c) throw new HttpsError(code || 'failed-precondition', msg); };
async function displayName(uid) { const s = await userInfo(uid).get(); const p = s.exists ? s.data() : {}; return p.fullname || p.username || 'Ẩn danh'; }
const isActive = (prof, subj) => !!(prof && prof.activeSubjects && prof.activeSubjects[subjectCode(subj)] && prof.activeSubjects[subjectCode(subj)].status === 'active');

/* ── 1. Duyệt đơn / kiểm tra bảng điểm / đình chỉ (chỉ main_admin) ── */
exports.m9_reviewApplication = onCall(OPT, async req => {
  const { uname } = await needMain(req);
  const { appDocId, action } = req.data || {};
  need(typeof appDocId === 'string' && appDocId, 'Thiếu appDocId.', 'invalid-argument');
  const uid = appDocId.split('_')[0], code = appDocId.slice(uid.length + 1);
  const appRef = D('m5_reviewer_applications', appDocId), profRef = D('m5_reviewer_profiles', uid);
  return db.runTransaction(async tx => {
    const [appS, profS] = await Promise.all([tx.get(appRef), tx.get(profRef)]);
    if (action === 'suspend' || action === 'reinstate') {
      need(profS.exists && profS.data().activeSubjects && profS.data().activeSubjects[code], 'Người này chưa có quyền ở môn này.');
      tx.update(profRef, { [`activeSubjects.${code}.status`]: action === 'suspend' ? 'suspended' : 'active', updatedAt: FV.serverTimestamp() });
      return { ok: true };
    }
    need(appS.exists, 'Không thấy đơn.', 'not-found');
    const a = appS.data(), base = { reviewedBy: uname, reviewedAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp() };
    if (action === 'check_pass' || action === 'check_fail') { tx.update(appRef, Object.assign({ proofCheckStatus: action === 'check_pass' ? 'passed' : 'failed' }, base)); return { ok: true }; }
    need(a.status === 'pending', 'Đơn không còn ở trạng thái chờ.');
    if (action === 'reject') { tx.update(appRef, Object.assign({ status: 'rejected' }, base)); return { ok: true }; }
    need(action === 'approve', 'Hành động không hợp lệ.', 'invalid-argument');
    need(a.proofCheckStatus === 'passed', 'Cần đánh dấu bảng điểm "đạt" trước khi duyệt.');
    const proofS = await tx.get(proofDoc(appDocId));
    need(proofS.exists && Number(proofS.data().gpaScore) >= M9_CONFIG.MIN_GPA, 'Điểm chưa đạt ngưỡng ' + M9_CONFIG.MIN_GPA + '.');
    const stats = profS.exists && profS.data().stats ? profS.data().stats : { totalVerifiedVersions: 0, reportedDocsCount: 0, confirmedWrongVersionsCount: 0, confirmedWrongRate: 0 };
    tx.update(appRef, Object.assign({ status: 'approved' }, base));
    tx.set(profRef, { uid, displayName: a.authorName || uid, school: 'UEH', stats, dailyReward: (profS.exists && profS.data().dailyReward) || { dateVN: '', totalKD: 0 },
      activeSubjects: { [code]: { status: 'active', learnedSemester: a.learnedSemester || 'chưa xác định', approvedAt: Date.now(), approvedBy: uname } }, updatedAt: FV.serverTimestamp() }, { merge: true });
    return { ok: true };
  });
});

/* ── 2. Nhận duyệt tài liệu ── */
exports.m9_claimDocument = onCall(OPT, async req => {
  const { role } = await roleOf(req); const uid = req.auth.uid;
  const { docId, contentVersion } = req.data || {};
  need(typeof docId === 'string' && docId, 'Thiếu docId.', 'invalid-argument');
  const name = await displayName(uid);
  return db.runTransaction(async tx => {
    const dRef = D('documents', docId), vRef = D('m5_verifications', docId + '_v' + contentVersion), pRef = D('m5_reviewer_profiles', uid);
    const [dS, vS, pS] = await Promise.all([tx.get(dRef), tx.get(vRef), tx.get(pRef)]);
    need(dS.exists, 'Không thấy tài liệu.', 'not-found');
    const d = dS.data(); need(d.status === 'approved', 'Tài liệu chưa được duyệt hiển thị.');
    need(d.uid !== uid, 'Không thể tự bảo chứng bài của mình.', 'permission-denied');              // I3
    need(verOf(d) === Number(contentVersion), 'Phiên bản tài liệu đã thay đổi, hãy tải lại.');
    const prof = pS.exists ? pS.data() : null; need(isActive(prof, d.subject), 'Bạn chưa là người bảo chứng đang hoạt động của môn này.', 'permission-denied');
    if (vS.exists) {                                                                                    // I2
      const v = vS.data();
      if (v.status === 'claimed') throw new HttpsError('failed-precondition', 'Tài liệu đang có người nhận duyệt.');
      if (['suspended_by_reports', 'revoked_wrong'].includes(v.status)) throw new HttpsError('failed-precondition', 'Phiên bản này đang/đã bị báo cáo, chờ phúc tra.');
      if (v.status === 'verified') { const cur = await tx.get(D('m5_reviewer_profiles', v.reviewerUid)); need(!isActive(cur.exists ? cur.data() : null, d.subject), 'Tài liệu đã được bảo chứng.'); }
    }
    const hist = (vS.exists && vS.data().claimHistory) || [];
    tx.set(vRef, { docId, contentVersion: verOf(d), subjectCode: subjectCode(d.subject), docTargetSemester: d.targetSemester || 'chưa xác định', reviewerUid: uid, reviewerName: name,
      reviewerLearnedSemester: (prof.activeSubjects[subjectCode(d.subject)].learnedSemester) || 'chưa xác định', status: 'claimed',
      checklist: { correctAnswers: false, correctLecturer: false, stillRelevant: false }, claimHistory: hist.concat([{ uid, action: 'claim', at: Date.now(), by: uid }]),
      lastResolutionId: vS.exists ? vS.data().lastResolutionId || null : null, claimedAt: FV.serverTimestamp(), verifiedAt: null, updatedAt: FV.serverTimestamp() });
    if (d.contentVersion == null) tx.update(dRef, { contentVersion: 1, targetSemester: d.targetSemester || 'chưa xác định' });   // migration lười
    return { ok: true };
  });
});

/* ── 3. Nhả bài / chuyển người nhận ── */
exports.m9_reassignClaim = onCall(OPT, async req => {
  const { role } = await roleOf(req); const uid = req.auth.uid, staff = ['admin', 'main_admin'].includes(role);
  const { docId, contentVersion, action, newReviewerUid } = req.data || {};
  return db.runTransaction(async tx => {
    const vRef = D('m5_verifications', docId + '_v' + contentVersion), vS = await tx.get(vRef);
    need(vS.exists && vS.data().status === 'claimed', 'Bài không ở trạng thái đang nhận.');
    const v = vS.data(), hist = (v.claimHistory || []);
    if (action === 'release') {
      need(v.reviewerUid === uid || staff, 'Bạn không giữ bài này.', 'permission-denied');
      tx.update(vRef, { status: 'released', claimHistory: hist.concat([{ uid: v.reviewerUid, action: 'release', at: Date.now(), by: uid }]), updatedAt: FV.serverTimestamp() });
    } else if (action === 'reassign') {
      need(staff, 'Chỉ Phó Tướng/Admin chính được chuyển bài.', 'permission-denied');
      const [dS, pS] = await Promise.all([tx.get(D('documents', docId)), tx.get(D('m5_reviewer_profiles', newReviewerUid))]);
      need(dS.exists && dS.data().uid !== newReviewerUid && isActive(pS.exists ? pS.data() : null, dS.data().subject), 'Người nhận mới không hợp lệ.');
      tx.update(vRef, { reviewerUid: newReviewerUid, reviewerName: pS.data().displayName || newReviewerUid, claimHistory: hist.concat([{ uid: newReviewerUid, action: 'reassign', at: Date.now(), by: uid }]), updatedAt: FV.serverTimestamp() });
    } else throw new HttpsError('invalid-argument', 'Hành động không hợp lệ.');
    return { ok: true };
  });
});

/* ── 4. Hoàn thành checklist, gắn nhãn Verified, thưởng KD (idempotent, trần theo ngày VN) ── */
exports.m9_submitVerification = onCall(OPT, async req => {
  await roleOf(req); const uid = req.auth.uid;
  const { docId, contentVersion, checklist, targetSemester } = req.data || {};
  need(checklist && checklist.correctAnswers === true && checklist.correctLecturer === true && checklist.stillRelevant === true, 'Cần hoàn thành đủ checklist.', 'invalid-argument');
  const eventId = `VERIFY_${docId}_v${contentVersion}_${uid}`;
  return db.runTransaction(async tx => {
    const refs = { d: D('documents', docId), v: D('m5_verifications', docId + '_v' + contentVersion), p: D('m5_reviewer_profiles', uid), l: D('m5_kd_ledger', eventId) };
    const [dS, vS, pS, lS] = await Promise.all([tx.get(refs.d), tx.get(refs.v), tx.get(refs.p), tx.get(refs.l)]);
    if (lS.exists) return { ok: true, alreadyProcessed: true, amount: lS.data().amount };          // I4
    need(dS.exists && vS.exists, 'Không thấy dữ liệu.', 'not-found');
    const d = dS.data(), v = vS.data(), prof = pS.data();
    need(v.status === 'claimed' && v.reviewerUid === uid, 'Bạn không giữ bài này.', 'permission-denied');
    need(d.uid !== uid, 'Không thể tự bảo chứng bài của mình.', 'permission-denied');               // I3
    need(verOf(d) === Number(contentVersion), 'Phiên bản đã thay đổi.');
    need(isActive(prof, d.subject), 'Quyền bảo chứng môn này đang bị đình chỉ.', 'permission-denied');
    const today = dateVN(), dr = prof.dailyReward || {}, soFar = dr.dateVN === today ? dr.totalKD || 0 : 0;
    const amount = Math.max(0, Math.min(M9_CONFIG.REWARD_PER_DOC, M9_CONFIG.DAILY_CAP_KD - soFar));   // I5: bài vượt trần vẫn duyệt, +0 KD
    const tsem = String(targetSemester || d.targetSemester || 'chưa xác định').slice(0, 40);
    const stats = Object.assign({ totalVerifiedVersions: 0, reportedDocsCount: 0, confirmedWrongVersionsCount: 0 }, prof.stats || {}); stats.totalVerifiedVersions += 1; stats.confirmedWrongRate = rate(stats);
    const sc = prof.activeSubjects[subjectCode(d.subject)];
    tx.update(refs.v, { status: 'verified', checklist, docTargetSemester: tsem, verifiedAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp() });
    tx.update(refs.d, { contentVersion: verOf(d), targetSemester: tsem, m9Badge: { status: 'verified', contentVersion: verOf(d), reviewerUid: uid, reviewerName: prof.displayName || v.reviewerName, subject: d.subject, learnedSemester: sc.learnedSemester || 'chưa xác định', targetSemester: tsem, verifiedAt: Date.now() } });
    tx.update(refs.p, { stats, dailyReward: { dateVN: today, totalKD: soFar + amount }, updatedAt: FV.serverTimestamp() });
    tx.set(refs.l, { eventId, uid, eventType: 'M9_VERIFY_REWARD', docId, contentVersion: verOf(d), amount, dateVN: today, dailyTotalAfter: soFar + amount, createdAt: FV.serverTimestamp() });
    if (amount > 0) tx.set(userInfo(uid), { kdCoins: FV.increment(amount) }, { merge: true });
    return { ok: true, amount };
  });
});

/* ── 5. Gửi báo cáo sai sót (đủ N báo cáo OPEN ⇒ tự tạm gỡ nhãn) ── */
exports.m9_submitReport = onCall(OPT, async req => {
  await roleOf(req); const uid = req.auth.uid;
  const { docId, contentVersion, reason, detail } = req.data || {};
  need(typeof reason === 'string' && reason.trim() && reason.length <= 500, 'Lý do không hợp lệ (1–500 ký tự).', 'invalid-argument');
  return db.runTransaction(async tx => {
    const rId = `${docId}_v${contentVersion}_${uid}`, rRef = D('m5_reports', rId), vRef = D('m5_verifications', docId + '_v' + contentVersion), dRef = D('documents', docId);
    const openQ = C('m5_reports').where('docId', '==', docId).where('contentVersion', '==', Number(contentVersion)).where('status', '==', 'OPEN');
    const [rS, vS, dS, openS] = await Promise.all([tx.get(rRef), tx.get(vRef), tx.get(dRef), tx.get(openQ)]);
    need(dS.exists, 'Không thấy tài liệu.', 'not-found');
    need(dS.data().uid !== uid, 'Không thể báo cáo bài của chính mình.', 'permission-denied');
    need(verOf(dS.data()) === Number(contentVersion), 'Phiên bản đã thay đổi.');
    if (rS.exists && rS.data().status === 'OPEN') return { ok: true, alreadyOpen: true };            // I1
    const count = openS.size + 1;
    tx.set(rRef, { docId, contentVersion: Number(contentVersion), reporterUid: uid, reason: reason.trim(), detail: String(detail || '').slice(0, 1000), status: 'OPEN', resolutionId: null, resolvedBy: null, resolvedAt: null, updatedAt: FV.serverTimestamp(), createdAt: rS.exists ? rS.data().createdAt : FV.serverTimestamp() });
    let suspended = false;
    if (count >= M9_CONFIG.REPORT_THRESHOLD_N && vS.exists && vS.data().status === 'verified') {      // I6
      suspended = true; const v = vS.data(), pRef = D('m5_reviewer_profiles', v.reviewerUid), pS = await tx.get(pRef);
      tx.update(vRef, { status: 'suspended_by_reports', updatedAt: FV.serverTimestamp() });
      tx.update(dRef, { 'm9Badge.status': 'suspended' });
      if (pS.exists && !v.reportedCounted) { tx.update(pRef, { 'stats.reportedDocsCount': FV.increment(1), updatedAt: FV.serverTimestamp() }); tx.update(vRef, { reportedCounted: true }); }
    }
    return { ok: true, suspended };
  });
});

/* ── 6. Phúc tra (chỉ main_admin, idempotent theo resolutionId) ── */
exports.m9_resolveReports = onCall(OPT, async req => {
  const { uname } = await needMain(req);
  const { docId, contentVersion, verdict, resolutionId } = req.data || {};
  need(['valid', 'invalid'].includes(verdict) && typeof resolutionId === 'string' && resolutionId, 'Tham số không hợp lệ.', 'invalid-argument');
  return db.runTransaction(async tx => {
    const vRef = D('m5_verifications', docId + '_v' + contentVersion), dRef = D('documents', docId);
    const openQ = C('m5_reports').where('docId', '==', docId).where('contentVersion', '==', Number(contentVersion)).where('status', '==', 'OPEN');
    const [vS, dS, openS] = await Promise.all([tx.get(vRef), tx.get(dRef), tx.get(openQ)]);
    need(vS.exists, 'Không thấy bản ghi bảo chứng.', 'not-found');
    const v = vS.data(); if (v.lastResolutionId === resolutionId) return { ok: true, alreadyProcessed: true };
    const pRef = D('m5_reviewer_profiles', v.reviewerUid), pS = await tx.get(pRef), prof = pS.exists ? pS.data() : null;
    const stamp = { resolutionId, resolvedBy: uname, resolvedAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp() };
    openS.docs.forEach(r => tx.update(r.ref, Object.assign({ status: verdict === 'valid' ? 'RESOLVED_VALID' : 'RESOLVED_INVALID' }, stamp)));
    if (verdict === 'invalid') {
      if (v.status === 'suspended_by_reports') { tx.update(vRef, { status: 'verified', lastResolutionId: resolutionId, updatedAt: FV.serverTimestamp() }); if (dS.exists) tx.update(dRef, { 'm9Badge.status': 'verified' }); }
      else tx.update(vRef, { lastResolutionId: resolutionId, updatedAt: FV.serverTimestamp() });
      return { ok: true };
    }
    tx.update(vRef, { status: 'revoked_wrong', lastResolutionId: resolutionId, updatedAt: FV.serverTimestamp() });
    if (dS.exists) tx.update(dRef, { 'm9Badge.status': 'none' });
    if (prof) {
      const stats = Object.assign({ totalVerifiedVersions: 0, reportedDocsCount: 0, confirmedWrongVersionsCount: 0 }, prof.stats || {}); stats.confirmedWrongVersionsCount += 1; stats.confirmedWrongRate = rate(stats);
      const upd = { stats, updatedAt: FV.serverTimestamp() };
      if (M9_CONFIG.WRONG_PENALTY_ENABLED) {                                                            // B06 — đang TẮT
        const sc = subjectCode(dS.exists ? dS.data().subject : v.subjectCode), lId = `AUDIT_${docId}_v${contentVersion}_${resolutionId}`;
        tx.set(D('m5_kd_ledger', lId), { eventId: lId, uid: v.reviewerUid, eventType: 'M9_AUDIT_PENALTY', docId, contentVersion: Number(contentVersion), amount: -M9_CONFIG.REWARD_PER_DOC, dateVN: dateVN(), dailyTotalAfter: (prof.dailyReward || {}).totalKD || 0, createdAt: FV.serverTimestamp() });
        tx.set(userInfo(v.reviewerUid), { kdCoins: FV.increment(-M9_CONFIG.REWARD_PER_DOC) }, { merge: true });
        if (stats.confirmedWrongRate > M9_CONFIG.AUTO_SUSPEND_RATE) upd[`activeSubjects.${sc}.status`] = 'suspended';
      }
      tx.update(pRef, upd);
    }
    return { ok: true };
  });
});

/* ── 7. Thưởng đăng tài liệu cũ (thay luồng client tự cộng kdCoins) ── */
exports.m9_claimLegacyReward = onCall(OPT, async req => {
  await roleOf(req); const uid = req.auth.uid, { type } = req.data || {};
  if (type !== 'doc') throw new HttpsError('unimplemented', 'Nhiệm vụ KD cần danh mục nhiệm vụ phía server (xem README).');
  const snap = await C('documents').where('uid', '==', uid).where('status', '==', 'approved').get();
  const mine = snap.docs.filter(s => !s.data().rewardClaimed).slice(0, 20);
  let total = 0;
  for (const s of mine) {
    total += await db.runTransaction(async tx => {
      const lId = `LEGACY_DOC_${s.id}`, lRef = D('m5_kd_ledger', lId), [lS, dS] = await Promise.all([tx.get(lRef), tx.get(s.ref)]);
      if (lS.exists || dS.data().rewardClaimed) return 0;
      tx.set(lRef, { eventId: lId, uid, eventType: 'LEGACY_DOC_REWARD', docId: s.id, contentVersion: null, amount: M9_CONFIG.LEGACY_DOC_REWARD, dateVN: dateVN(), dailyTotalAfter: 0, createdAt: FV.serverTimestamp() });
      tx.update(s.ref, { rewardClaimed: true });
      tx.set(userInfo(uid), { kdCoins: FV.increment(M9_CONFIG.LEGACY_DOC_REWARD) }, { merge: true });
      return M9_CONFIG.LEGACY_DOC_REWARD;
    });
  }
  return { ok: true, amount: total };
});

/* ── 8. Sửa nội dung quan trọng ⇒ tăng contentVersion, nhãn cũ hết hiệu lực ── */
exports.m9_updateDocumentContent = onCall(OPT, async req => {
  const { role } = await roleOf(req); const uid = req.auth.uid, { docId, patch } = req.data || {};
  const ALLOWED = ['url', 'title', 'subject', 'teacher', 'note', 'type', 'targetSemester'];
  need(patch && Object.keys(patch).length && Object.keys(patch).every(k => ALLOWED.includes(k)), 'Trường sửa không hợp lệ.', 'invalid-argument');
  return db.runTransaction(async tx => {
    const dRef = D('documents', docId), dS = await tx.get(dRef); need(dS.exists, 'Không thấy tài liệu.', 'not-found');
    const d = dS.data(); need(d.uid === uid || role !== 'user', 'Không có quyền sửa.', 'permission-denied');
    const old = verOf(d), vRef = D('m5_verifications', docId + '_v' + old), vS = await tx.get(vRef);
    const clean = {}; Object.keys(patch).forEach(k => { clean[k] = String(patch[k]).slice(0, 500); });
    tx.update(dRef, Object.assign(clean, { contentVersion: old + 1, m9Badge: null }));
    if (vS.exists && vS.data().status !== 'superseded') tx.update(vRef, { status: 'superseded', updatedAt: FV.serverTimestamp() });
    return { ok: true, contentVersion: old + 1 };
  });
});
