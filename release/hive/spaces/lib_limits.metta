;; Purpose: decide who may set or remove a spending limit (Jon on #615 and #256).
;;
;; (limit-decide $limit (Target $seen $owner $personal) (By $kind $id $admin)) -> (Granted) or (Refused reason).
;; The host supplies the facts and enforces the verdict (limits_view.limit_refusal, through limit_policy.py).
;;
;; $limit is the kind of the limit's scope: "agent" (a mind) or "swarm" for a cap on one, or "hive", "every-mind",
;; "person" (a person's allowance) or "key". Target is the mind or swarm a cap is on, as the host found it for this
;; asker: $seen is True when it exists and the asker may see it (the hive's visibility rule), and $owner and $personal
;; are the person it records as its owner and the person it is the personal mind or swarm of, "" for none. Every other
;; limit has no target, and the host passes (Target False "" ""). By is who asks: kind "person", a signed-in person,
;; with $admin True for a hive admin, or kind "hive", the hive itself reading its own limits with nobody signed in.
;; Identities are hex strings, and "" means the host has none.
;;
;; A cap on a mind or a swarm is its own person's alone: its owner's, or the person's it is the personal mind or swarm
;; of. Anyone else who sees it, a hive admin included, is refused owner-only and can ask that person (Jon on #615:
;; "No admin controls another user"; on #256, a cap on a mind is set only by that mind's owner). One that records
;; neither was made before owners were recorded and is an admin's, as everything else on it is. One the asker can't see
;; is not-found, as one that doesn't exist is. Every other limit, the hive cap, a person's allowance, the every-mind
;; rule and a key's limit, is a hive admin's.
;;
;; Guards are written "if ok then go on, else refuse", as the hive boundary's laws are: a condition that is not a
;; boolean takes the else branch in this engine, and so the else branch refuses.

(= (limit-cap-kind? $limit)
   (if (== $limit "agent") True (== $limit "swarm")))

(= (limit-admin-kind? $limit)
   (if (== $limit "hive") True
       (if (== $limit "every-mind") True
           (if (== $limit "person") True (== $limit "key")))))

(= (limit-known? $limit)
   (if (limit-cap-kind? $limit) True (limit-admin-kind? $limit)))

(= (limit-person? $kind $id)
   (if (== $kind "person") (if (== $id "") False True) False))

;; Whether the person $id is the target's own person. A target recording neither an owner nor a person is an admin's.
(= (limit-own-person? $id $admin $owner $personal)
   (if (== $owner "")
       (if (== $personal "") (== $admin True) (== $id $personal))
       (if (== $id $owner) True (== $id $personal))))

(= (limit-cap $seen $owner $personal $id $admin)
   (if (== $seen True)
       (if (limit-own-person? $id $admin $owner $personal) (Granted) (Refused owner-only))
       (Refused not-found)))

(= (limit-for-person $limit $seen $owner $personal $id $admin)
   (if (limit-cap-kind? $limit)
       (limit-cap $seen $owner $personal $id $admin)
       (if (limit-admin-kind? $limit)
           (if (== $admin True) (Granted) (Refused admin-only))
           (Refused unknown-limit))))

(= (limit-decide $limit (Target $seen $owner $personal) (By $kind $id $admin))
   (if (== $kind "hive")
       (if (limit-known? $limit) (Granted) (Refused unknown-limit))
       (if (limit-person? $kind $id)
           (limit-for-person $limit $seen $owner $personal $id $admin)
           (Refused invalid-asker))))
