import { NextApiRequest, NextApiResponse } from 'next'
import { ApiError, ValidationError } from 'web/pages/api/v0/_types'
import { applyCorsHeaders, CORS_UNRESTRICTED } from 'web/lib/api/cors'
import { contractUrl } from 'common/contract'
import { filterDefined } from 'common/util/array'
import {
  listAllComments,
  listAllCommentsOnPost,
} from 'web/lib/firebase/comments'
import { ENV_CONFIG } from 'common/envs/constants'
import { postPath } from 'web/lib/firebase/posts'
import { getPost } from 'web/lib/supabase/post'
import { richTextToString } from 'common/util/parse'
import { getUser } from 'web/lib/firebase/users'
import { getContract } from 'web/lib/supabase/contracts'
import { run } from 'common/supabase/utils'
import { db } from 'web/lib/supabase/db'

type LiteReport = {
  reportedById: string
  slug: string
  id: string
  text: string
  contentOwnerId: string
  reasonsDescription: string
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<LiteReport[] | ValidationError | ApiError>
) {
  await applyCorsHeaders(req, res, CORS_UNRESTRICTED)
  const { data: reports } = await run(
    db
      .from('reports')
      .select()
      .order('created_time', { ascending: false } as any)
      .limit(100)
  )

  const liteReports: LiteReport[] = filterDefined(
    await Promise.all(
      reports.map(async (report) => {
        const {
          content_id,
          content_type,
          content_owner_id,
          parent_type,
          parent_id,
          user_id,
          id,
          report_description,
        } = report

        let partialReport: { slug: string; text: string } | null = null
        // Reported contract
        if (content_type === 'contract') {
          const contract = await getContract(content_id)
          partialReport = contract
            ? {
                slug: contractUrl(contract),
                text: contract.question,
              }
            : null
          // Reported comment on a contract
        } else if (
          content_type === 'comment' &&
          parent_type === 'contract' &&
          parent_id
        ) {
          const contract = await getContract(parent_id)
          if (contract) {
            const comments = (await listAllComments(contract.id)).filter(
              (comment) => comment.id === content_id
            )
            const comment = comments[0]
            partialReport =
              comments.length > 0
                ? {
                    slug: contractUrl(contract) + '#' + comment.id,
                    text: comment.text
                      ? comment.text
                      : richTextToString(comment.content),
                  }
                : null
          }
          // Reported comment on a post
        } else if (
          content_type === 'comment' &&
          parent_type === 'post' &&
          parent_id
        ) {
          const post = await getPost(parent_id)
          if (post) {
            const comments = (await listAllCommentsOnPost(post.id)).filter(
              (comment) => comment.id === content_id
            )
            partialReport =
              comments.length > 0
                ? {
                    slug:
                      `https://${ENV_CONFIG.domain}${postPath(post.slug)}` +
                      '#' +
                      comments[0].id,
                    text: richTextToString(comments[0].content),
                  }
                : null
          }
          // Reported a user, probably should add a field as to why they were reported
        } else if (content_type === 'user') {
          const reportedUser = await getUser(content_id)
          partialReport = {
            slug: `https://${ENV_CONFIG.domain}/${reportedUser.username}`,
            text: reportedUser.name,
          }
        }
        return partialReport
          ? {
              ...partialReport,
              reasonsDescription: report_description ?? '',
              contentOwnerId: content_owner_id,
              id,
              reportedById: user_id,
            }
          : null
      })
    )
  )

  res.status(200).json(liteReports)
}
