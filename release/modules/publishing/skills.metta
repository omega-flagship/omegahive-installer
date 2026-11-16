(= (write-web-page $slug $html)
   (py-call (publishing.write_web_page $slug $html)))

(= (list-web-pages)
   (py-call (publishing.list_web_pages)))

(= (public-web-url $slug)
   (py-call (publishing.public_web_url $slug)))

(= (webhost-status)
   (py-call (publishing.webhost_status)))

(= (publish-artifact $artifact_id $member $title)
   (py-call (publishing.publish_artifact $artifact_id $member $title)))

(= (artifact-id $path)
   (py-call (publishing.artifact_id_for_path $path)))

(= (unpublish-artifact $slug)
   (py-call (publishing.unpublish_artifact $slug)))

(= (list-published-artifacts)
   (py-call (publishing.list_published_artifacts)))
