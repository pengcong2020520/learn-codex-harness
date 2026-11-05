// 生成服务由主流程注入；工具快照不携带密钥、数据库连接或后台定时器。
export function createTools({ media }) {
  return {
    generate_image: (args, context) => media.generateImage(args, context),
    generate_video: (args, context) => media.generateVideo(args, context),
    media_status: args => media.status(args),
  };
}
