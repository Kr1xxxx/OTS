# Pending release notes

A pull request that changes what the installed app does adds one file here, named after the change
(`backup-shares-images.md`). Write one to three short lines in Chinese, for the person using the
app: what they will notice, not how it was done. Each line is at most 100 characters.

```
备份不再每次把全部图片重写一遍，只写新增的图片
```

Do not change `VERSION` in a pull request. After the merge, once CI has passed on main, the release
workflow takes the next version number, moves the notes from this folder into
`release-notes/v<version>.md` and publishes. The app shows the first five lines of that file in the
"发现新版本" dialog before installing.

A change that does not need to reach the installed app (tests, tooling, documentation) adds nothing
here, and nothing is released.
