---
title: DDL・DML・DCL
分野: 09_データベース
難度: 易
---

# DDL・DML・DCL

> SQLの3分類。
> **定義**（CREATE）・**操作**（SELECT）・**制御**（GRANT）に対応する。

## なぜそうなるのか

| 分類 | 正式名称 | 何をするか | 代表的な命令 |
|---|---|---|---|
| DDL | Data Definition Language | 表や索引の**構造を作る・変える** | CREATE、ALTER、DROP |
| DML | Data Manipulation Language | データを**取り出す・入れる・変える** | SELECT、INSERT、UPDATE、DELETE |
| DCL | Data Control Language | **権限**とトランザクションを制御する | GRANT、REVOKE、COMMIT、ROLLBACK |

**D**efinition＝定義（入れ物を作る）、**M**anipulation＝操作（中身を扱う）、
**C**ontrol＝制御（誰に許すか）。英単語の意味がそのまま分類名です。

## 試験での問われ方

- 「GRANTはどの分類に属するか」→ **DCL**

## 関連

[[SELECT文]] ／ [[コミット]]

教科書：[[教科書/09_データベース|09_データベース]] の 3.1 節
