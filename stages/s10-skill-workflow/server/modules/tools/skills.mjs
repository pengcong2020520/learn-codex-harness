// 隐式触发 Skill：模型从技能清单里看到名称和描述后，自己决定是否读取。只能读已启用 Skill 目录里的白名单文件。
export function createTools({ skills }) {
  return {
    skill_read: async ({ name, file }) => {
      if (!skills) throw new Error("Skill 读取服务未启动。");
      return skills.read(name, file);
    }
  };
}
