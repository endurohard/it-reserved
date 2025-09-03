// utils/orgConfig.js
export function getOrgConfig(orgId) {
  const prefix = `ORG${orgId}_`;
  return {
    login: process.env[`${prefix}LOGIN`],
    password: process.env[`${prefix}PASSWORD`],
    groupUrl: process.env[`${prefix}GROUP_URL`],
    sipRemove: (process.env[`${prefix}SIP_REMOVE`] || '').split(',').map(s => s.trim()).filter(Boolean),
    sipAdd: (process.env[`${prefix}SIP_ADD`] || '').split(',').map(s => s.trim()).filter(Boolean),
    mobRemove: (process.env[`${prefix}MOB_REMOVE`] || '').split(',').map(s => s.trim()).filter(Boolean),
    mobAdd: (process.env[`${prefix}MOB_ADD`] || '').split(',').map(s => s.trim()).filter(Boolean),
  };
}