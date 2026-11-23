; Purpose: declare who can receive, view, pause and resume a spend alert.
; Ground facts from the host identify the current relationship to the paid scope.
; A missing permission denies the operation.
(SpendPermission hive receive system-owner)
(SpendPermission hive view system-owner)
(SpendPermission hive pause system-owner)
(SpendPermission hive resume system-owner)
(SpendPermission mind receive mind-owner)
(SpendPermission mind view mind-owner)
(SpendPermission mind pause mind-owner)
(SpendPermission mind resume mind-owner)
