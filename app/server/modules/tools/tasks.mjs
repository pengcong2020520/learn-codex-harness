// 提议任务：模型可以提议，不能自己批准。提议只记录为 proposed，用户确认后由服务端按 workflow 授权执行。
export function createTools({ tasks }) {
  return {
    propose_task: async (args, { context } = {}) => {
      if (!tasks || !context?.threadId) throw new Error("提议任务需要数据层提供的会话身份。");
      return tasks.propose(context, args);
    }
  };
}
