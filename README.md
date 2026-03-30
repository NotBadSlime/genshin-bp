# genshin-bp

原神 **Ban/Pick（BP）** 插件，适用于 [Yunzai-Bot](https://gitee.com/TimeRainStarSky/Yunzai) 系机器人。

## 安装

将本仓库克隆到机器人目录下的 `plugins/genshin-bp`：

```bash
cd plugins
git clone https://github.com/NotBadSlime/genshin-bp.git
```

重启机器人后加载插件。

## 依赖

- **喵喵插件**（`miao-plugin`）：角色头像与 `Character` 元数据  
- **原神插件**（`genshin`）：`resolveGsReleaseName` 角色别名解析  
- **Redis**：对局状态存储  
- **node-fetch**：拉取 QQ 头像（若环境未提供全局 `fetch`）

## 使用

群内发送 `#bp帮助` 查看说明图（长图）。

## 仓库

https://github.com/NotBadSlime/genshin-bp
