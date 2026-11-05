export function createTools({ knowledge }) {
  const invoke = method => args => {
    if (!knowledge) throw new Error('知识层需要 PostgreSQL 数据服务。');
    return knowledge[method](args);
  };
  return { kb_list: () => { if (!knowledge) throw new Error('知识层未启动。'); return knowledge.list(); },
    kb_read: invoke('read'), kb_search: invoke('search'), kb_submit_revision: invoke('submit') };
}
