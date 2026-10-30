import { execFile } from 'node:child_process';

/** Do not cache failures: an administrator can pull/build the image while the
 * service is running. No model/provider selection happens before this check. */
export async function checkContainerImage(
  image: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'docker',
      ['image', 'inspect', '--', image],
      { timeout: 10000, maxBuffer: 1024 * 1024 },
      (error, _stdout, stderr) => {
        if (!error) return resolve(null);
        const detail = String(stderr || '');
        if (/No such (image|object)/i.test(detail)) {
          resolve(
            `Agent 容器镜像 ${image} 尚未安装。请在运行服务的电脑执行 docker pull ${image}；如果仓库未发布或无权拉取，请由管理员发布镜像，或从本项目 container 目录构建同名镜像后重试。`,
          );
        } else {
          resolve(
            '无法检查 Agent 容器镜像，请确认 Docker 已启动且当前服务有权连接 Docker。',
          );
        }
      },
    );
  });
}

/** Classify Docker CLI startup failures before its trailing help text can
 * hide the actual cause. Do not echo registry diagnostics or host paths: they
 * may contain private registry credentials or user filesystem names. */
export function containerStartupError(
  stderr: string,
  exitCode: number | null,
  exitLabel: string,
): { result: null; error: string } {
  if (exitCode === 125) {
    if (
      /pull access denied|repository does not exist|manifest unknown|no such image/i.test(
        stderr,
      )
    ) {
      return {
        result: null,
        error:
          'Agent 容器镜像不可用或无权拉取。请在运行服务的 Docker 环境中安装配置的镜像；如果镜像未发布，可在项目 container 目录构建后重试。',
      };
    }
    if (/bind source path does not exist/i.test(stderr)) {
      return {
        result: null,
        error:
          '容器挂载目录在 Docker 环境中不存在。请检查工作区目录，并确认它已共享给 Docker 虚拟机；macOS 的系统临时目录可能未共享。',
      };
    }
  }
  return {
    result: null,
    error: `Container exited with ${exitLabel}: ${stderr.slice(-200)}`,
  };
}
