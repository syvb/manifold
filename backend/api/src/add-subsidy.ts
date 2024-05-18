import * as admin from 'firebase-admin'
import { Contract, CPMMContract } from 'common/contract'
import { User } from 'common/user'
import { getNewLiquidityProvision } from 'common/add-liquidity'
import { APIError, type APIHandler } from './helpers/endpoint'
import { SUBSIDY_FEE } from 'common/economy'
import { insertTxn } from 'shared/txn/run-txn'
import { createSupabaseDirectClient } from 'shared/supabase/init'

export const addLiquidity: APIHandler<
  'market/:contractId/add-liquidity'
> = async ({ contractId, amount }, auth) => {
  return addContractLiquidity(contractId, amount, auth.uid)
}

export const addContractLiquidity = async (contractId: string, amount: number, userId: string) => {
  const pg = createSupabaseDirectClient()

  // run as transaction to prevent race conditions
  const provision = await firestore.runTransaction(async (transaction) => {
    const userDoc = firestore.doc(`users/${userId}`)
    const userSnap = await transaction.get(userDoc)
    if (!userSnap.exists) throw new APIError(401, 'Your account was not found')
    const user = userSnap.data() as User

    const contractDoc = firestore.doc(`contracts/${contractId}`)
    const contractSnap = await transaction.get(contractDoc)
    if (!contractSnap.exists) throw new APIError(404, 'Contract not found')
    const contract = contractSnap.data() as Contract
    if (
      contract.mechanism !== 'cpmm-1' &&
      contract.mechanism !== 'cpmm-multi-1'
    )
      throw new APIError(
        500,
        'Invalid contract, only cpmm-1 and cpmm-multi-1 are supported'
      )

    const { closeTime } = contract
    if (closeTime && Date.now() > closeTime)
      throw new APIError(403, 'Trading is closed')

    if (!isFinite(amount)) {
      throw new APIError(400, 'Invalid amount')
    }

    if (user.balance < amount) throw new APIError(403, 'Insufficient balance')

    transaction.update(userDoc, {
      balance: admin.firestore.FieldValue.increment(-amount),
      totalDeposits: admin.firestore.FieldValue.increment(-amount),
    })

    const newLiquidityProvisionDoc = firestore
      .collection(`contracts/${contractId}/liquidity`)
      .doc()

    const subsidyAmount = (1 - SUBSIDY_FEE) * amount

    const { newLiquidityProvision, newTotalLiquidity, newSubsidyPool } =
      getNewLiquidityProvision(
        userId,
        subsidyAmount,
        contract,
        newLiquidityProvisionDoc.id
      )

    transaction.update(contractDoc, {
      subsidyPool: newSubsidyPool,
      totalLiquidity: newTotalLiquidity,
    } as Partial<CPMMContract>)

    transaction.create(newLiquidityProvisionDoc, newLiquidityProvision)
    return newLiquidityProvision
  })

  await pg.tx((tx) =>
    insertTxn(tx, {
      fromId: userId,
      amount: amount,
      toId: contractId,
      toType: 'CONTRACT',
      category: 'ADD_SUBSIDY',
      token: 'M$',
      fromType: 'USER',
    })
  )

  return provision
}

const firestore = admin.firestore()
