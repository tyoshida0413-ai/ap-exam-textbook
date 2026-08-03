---
title: SELECT文
分野: 09_データベース
難度: 易
---

# SELECT文

> **表からデータを取り出すSQL**。
> WHEREで行を絞り、ORDER BYで並べ替える。

## なぜそうなるのか

**書く順番と実行される順番が違う**点が理解の要です。

| 書く順 | SELECT → FROM → WHERE → GROUP BY → HAVING → ORDER BY |
|---|---|
| 実行順 | **FROM → WHERE → GROUP BY → HAVING → SELECT → ORDER BY** |

```sql
SELECT 氏名, 給与 FROM 社員表 WHERE 給与 >= 300 ORDER BY 給与 DESC;
```

## 試験での問われ方

- SQL文を提示して結果を答えさせる問題は、**実行順で追えば必ず解ける**

## 関連

[[GROUP BY句]] ／ [[HAVING句]] ／ [[DDL・DML・DCL]]

教科書：[[09_データベース]] の 3.2 節
