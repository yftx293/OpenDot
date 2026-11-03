import { useState } from 'react';
import {
  Github,
  ExternalLink,
  Heart,
  Code2,
  Lightbulb,
  Bug,
} from 'lucide-react';
import { BugReportDialog } from '@/components/common/BugReportDialog';
import { Button } from '@/components/ui/button';

export function AboutSection() {
  const [showBugReport, setShowBugReport] = useState(false);

  return (
    <div className="space-y-6">
      {/* 项目信息 */}
      <div>
        <h2 className="text-lg font-semibold text-foreground mb-1">OpenDot</h2>
        <p className="text-sm text-muted-foreground">
          基于 Pi Runtime 的个人 AI 助手与团队
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          版本 1.0.0 · MIT License
        </p>
      </div>

      {/* 开源地址 & 作者 & 报告问题 */}
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <Github className="w-4 h-4 text-muted-foreground shrink-0" />
          <a
            href="https://github.com/yftx293/OpenDot"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-primary hover:text-primary/80 inline-flex items-center gap-1"
          >
            yftx293/OpenDot
            <ExternalLink className="w-3 h-3" />
          </a>
        </div>
        <div className="flex items-center gap-3">
          <Code2 className="w-4 h-4 text-muted-foreground shrink-0" />
          <span className="text-sm text-foreground">作者：Yu (@yftx293)</span>
        </div>
        <div className="flex items-center gap-3">
          <Bug className="w-4 h-4 text-muted-foreground shrink-0" />
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowBugReport(true)}
          >
            <Bug className="w-3.5 h-3.5" />
            报告问题
          </Button>
        </div>
      </div>

      <BugReportDialog
        open={showBugReport}
        onClose={() => setShowBugReport(false)}
      />

      <hr className="border-border" />

      {/* 灵感来源 */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Lightbulb className="w-4 h-4 text-amber-500" />
          <h3 className="text-sm font-medium text-foreground">灵感来源</h3>
        </div>
        <div className="space-y-4 text-sm text-muted-foreground">
          <div>
            <a
              href="https://github.com/slopus/happy"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:text-primary/80 font-medium inline-flex items-center gap-1"
            >
              Happy
              <ExternalLink className="w-3 h-3" />
            </a>
            <p className="mt-1 leading-relaxed">
              Claude Code Web
              化方向的重要启发项目，让用户可以通过浏览器在不同设备上继续使用
              Claude Code 工作流。
            </p>
          </div>
          <div>
            <a
              href="https://github.com/openclaw/openclaw"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:text-primary/80 font-medium inline-flex items-center gap-1"
            >
              OpenClaw
              <ExternalLink className="w-3 h-3" />
            </a>
            <p className="mt-1 leading-relaxed">
              自托管个人智能体产品方向的重要参考。OpenDot 使用 Pi Runtime，
              并在其上提供可观察的任务、渠道与团队控制。
            </p>
          </div>
        </div>
      </div>

      <hr className="border-border" />

      {/* 设计哲学 */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Heart className="w-4 h-4 text-rose-500" />
          <h3 className="text-sm font-medium text-foreground">设计哲学</h3>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">
          复用 Pi Runtime，把产品重心放在对话、持续委托和清晰可控的团队协作上。
        </p>
      </div>
    </div>
  );
}
