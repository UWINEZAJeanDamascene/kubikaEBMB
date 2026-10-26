/**
 * EBMNotice — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  ebmNoticeToApi,
  ebmNoticeTranslateCreate,
  ebmNoticeTranslateUpdate,
} = require('../utils/phase10Mappers');

const FIELD_MAP = {
  noticeNumber: { target: 'noticeNumber' },
  title: { target: 'title' },
  content: { target: 'content' },
  detailUrl: { target: 'detailUrl' },
  registrantName: { target: 'registrantName' },
  source: { target: 'source' },
  lastSyncedAt: { target: 'lastSyncedAt' },
  active: { target: 'active' },
  noticeDate: { target: 'noticeDate' },
};

module.exports = buildTenantModel({
  name: 'EBMNotice',
  collection: 'ebmnotices',
  delegateName: 'ebmNotice',
  fieldMap: FIELD_MAP,
  toApi: ebmNoticeToApi,
  translateCreate: ebmNoticeTranslateCreate,
  translateUpdate: ebmNoticeTranslateUpdate,
  mutable: true,
});
