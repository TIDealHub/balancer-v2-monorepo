import { ethers } from 'hardhat';
import { BytesLike, BigNumber } from 'ethers';
import { expect } from 'chai';
import { Contract, utils } from 'ethers';

import { deploy } from '@balancer-labs/v2-helpers/src/contract';
import Vault from '@balancer-labs/v2-helpers/src/models/vault/Vault';
import { expectBalanceChange } from '@balancer-labs/v2-helpers/src/test/tokenBalance';
import Token from '@balancer-labs/v2-helpers/src/models/tokens/Token';
import TokenList from '@balancer-labs/v2-helpers/src/models/tokens/TokenList';
import * as expectEvent from '@balancer-labs/v2-helpers/src/test/expectEvent';

import { bn } from '@balancer-labs/v2-helpers/src/numbers';
import { MerkleTree } from '../lib/merkleTree';

import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';

function encodeElement(address: string, balance: BigNumber): string {
  return ethers.utils.solidityKeccak256(['address', 'uint'], [address, balance]);
}

interface Claim {
  distribution: BigNumber;
  balance: BigNumber;
  rewarder: string;
  rewardToken: string;
  merkleProof: BytesLike[];
}

describe('MerkleOrchard', () => {
  let rewardTokens: TokenList, rewardToken: Token, vault: Contract, merkleOrchard: Contract;

  let admin: SignerWithAddress,
    rewarder: SignerWithAddress,
    lp1: SignerWithAddress,
    lp2: SignerWithAddress,
    other: SignerWithAddress;
  const rewardTokenInitialBalance = bn(100e18);
  const distribution1 = bn(1);

  before('setup', async () => {
    [, admin, rewarder, lp1, lp2, other] = await ethers.getSigners();
  });

  sharedBeforeEach('deploy vault and tokens', async () => {
    const vaultHelper = await Vault.create({ admin });
    vault = vaultHelper.instance;

    rewardTokens = await TokenList.create(['DAI'], { sorted: true });
    rewardToken = rewardTokens.DAI;

    merkleOrchard = await deploy('MerkleOrchard', {
      args: [vault.address],
      from: admin,
    });
    await rewardTokens.mint({ to: rewarder.address, amount: rewardTokenInitialBalance });
    await rewardTokens.approve({ to: merkleOrchard.address, from: [rewarder] });
  });

  it('stores an allocation', async () => {
    const claimBalance = bn('9876');

    const elements = [encodeElement(lp1.address, claimBalance)];
    const merkleTree = new MerkleTree(elements);
    const root = merkleTree.getHexRoot();

    await merkleOrchard.connect(rewarder).seedAllocations(rewardToken.address, distribution1, root, claimBalance);

    const proof = merkleTree.getHexProof(elements[0]);

    const result = await merkleOrchard.verifyClaim(
      rewardToken.address,
      rewarder.address,
      lp1.address,
      1,
      claimBalance,
      proof
    );
    expect(result).to.equal(true);
  });

  it('emits RewardAdded when an allocation is stored', async () => {
    const claimBalance = bn('9876');

    const elements = [encodeElement(lp1.address, claimBalance)];
    const merkleTree = new MerkleTree(elements);
    const root = merkleTree.getHexRoot();

    const receipt = await (
      await merkleOrchard.connect(rewarder).seedAllocations(rewardToken.address, distribution1, root, claimBalance)
    ).wait();

    expectEvent.inReceipt(receipt, 'RewardAdded', {
      token: rewardToken.address,
      amount: claimBalance,
    });
  });

  it('requisitions tokens when it stores a balance', async () => {
    const claimBalance = bn('9876');

    const elements = [encodeElement(lp1.address, claimBalance)];
    const merkleTree = new MerkleTree(elements);
    const root = merkleTree.getHexRoot();

    await expectBalanceChange(
      () => merkleOrchard.connect(rewarder).seedAllocations(rewardToken.address, distribution1, root, claimBalance),
      rewardTokens,
      [{ account: merkleOrchard, changes: { DAI: claimBalance } }],
      vault
    );
  });

  it('stores multiple allocations', async () => {
    const claimBalance0 = bn('1000');
    const claimBalance1 = bn('2000');

    const elements = [encodeElement(lp1.address, claimBalance0), encodeElement(lp2.address, claimBalance1)];
    const merkleTree = new MerkleTree(elements);
    const root = merkleTree.getHexRoot();

    await merkleOrchard.connect(rewarder).seedAllocations(rewardToken.address, 1, root, bn('3000'));

    const proof0 = merkleTree.getHexProof(elements[0]);
    let result = await merkleOrchard.verifyClaim(
      rewardToken.address,
      rewarder.address,
      lp1.address,
      1,
      claimBalance0,
      proof0
    );
    expect(result).to.equal(true); //"account 0 should have an allocation";

    const proof1 = merkleTree.getHexProof(elements[1]);
    result = await merkleOrchard.verifyClaim(
      rewardToken.address,
      rewarder.address,
      lp2.address,
      1,
      claimBalance1,
      proof1
    );
    expect(result).to.equal(true); // "account 1 should have an allocation";
  });

  describe('with an allocation', () => {
    const claimableBalance = bn('1000');
    let elements: string[];
    let merkleTree: MerkleTree;
    let claims: Claim[];

    sharedBeforeEach(async () => {
      elements = [encodeElement(lp1.address, claimableBalance)];
      merkleTree = new MerkleTree(elements);
      const root = merkleTree.getHexRoot();

      await merkleOrchard.connect(rewarder).seedAllocations(rewardToken.address, 1, root, claimableBalance);
      const merkleProof: BytesLike[] = merkleTree.getHexProof(elements[0]);

      claims = [
        {
          distribution: bn(1),
          balance: claimableBalance,
          rewarder: rewarder.address,
          rewardToken: rewardToken.address,
          merkleProof,
        },
      ];
    });

    it('allows the user to claim a single distribution', async () => {
      await expectBalanceChange(
        () => merkleOrchard.connect(lp1).claimDistributions(lp1.address, claims),
        rewardTokens,
        [{ account: lp1, changes: { DAI: claimableBalance } }]
      );
    });

    it('emits RewardPaid when an allocation is claimed', async () => {
      const receipt = await (await merkleOrchard.connect(lp1).claimDistributions(lp1.address, claims)).wait();

      expectEvent.inReceipt(receipt, 'RewardPaid', {
        user: lp1.address,
        rewardToken: rewardToken.address,
        amount: claimableBalance,
      });
    });

    it('marks claimed distributions as claimed', async () => {
      await merkleOrchard.connect(lp1).claimDistributions(lp1.address, claims);

      const isClaimed = await merkleOrchard.claimed(rewardToken.address, rewarder.address, 1, lp1.address);
      expect(isClaimed).to.equal(true); // "claim should be marked as claimed";
    });

    it('reverts when a user attempts to claim for another user', async () => {
      const errorMsg = 'user must claim own balance';
      await expect(merkleOrchard.connect(other).claimDistributions(lp1.address, claims)).to.be.revertedWith(errorMsg);
    });

    it('reverts when the user attempts to claim the wrong balance', async () => {
      const incorrectClaimedBalance = bn('666');
      const merkleProof = merkleTree.getHexProof(elements[0]);
      const errorMsg = 'Incorrect merkle proof';

      const claimsWithIncorrectClaimableBalance = [
        {
          distribution: 1,
          balance: incorrectClaimedBalance,
          rewarder: rewarder.address,
          rewardToken: rewardToken.address,
          merkleProof,
        },
      ];
      await expect(
        merkleOrchard.connect(lp1).claimDistributions(lp1.address, claimsWithIncorrectClaimableBalance)
      ).to.be.revertedWith(errorMsg);
    });

    it('reverts when the user attempts to claim twice', async () => {
      await merkleOrchard.connect(lp1).claimDistributions(lp1.address, claims);

      const errorMsg = 'cannot claim twice';
      await expect(merkleOrchard.connect(lp1).claimDistributions(lp1.address, claims)).to.be.revertedWith(errorMsg);
    });

    it('reverts when an admin attempts to overwrite an allocationn', async () => {
      const elements2 = [encodeElement(lp1.address, claimableBalance), encodeElement(lp2.address, claimableBalance)];
      const merkleTree2 = new MerkleTree(elements2);
      const root2 = merkleTree2.getHexRoot();

      const errorMsg = 'cannot rewrite merkle root';
      expect(
        merkleOrchard.connect(admin).seedAllocations(rewardToken.address, 1, root2, claimableBalance.mul(2))
      ).to.be.revertedWith(errorMsg);
    });
  });

  describe('with several allocations', () => {
    const claimBalance1 = bn('1000');
    const claimBalance2 = bn('1234');

    let elements1: string[];
    let merkleTree1: MerkleTree;
    let root1: string;

    let elements2: string[];
    let merkleTree2: MerkleTree;
    let root2: string;

    sharedBeforeEach(async () => {
      elements1 = [encodeElement(lp1.address, claimBalance1)];
      merkleTree1 = new MerkleTree(elements1);
      root1 = merkleTree1.getHexRoot();

      elements2 = [encodeElement(lp1.address, claimBalance2)];
      merkleTree2 = new MerkleTree(elements2);
      root2 = merkleTree2.getHexRoot();

      await merkleOrchard.connect(rewarder).seedAllocations(rewardToken.address, distribution1, root1, claimBalance1);

      await merkleOrchard.connect(rewarder).seedAllocations(rewardToken.address, bn(2), root2, claimBalance2);
    });

    it('allows the user to claim multiple distributions at once', async () => {
      const claimedBalance1 = bn('1000');
      const claimedBalance2 = bn('1234');

      const proof1: BytesLike[] = merkleTree1.getHexProof(elements1[0]);
      const proof2: BytesLike[] = merkleTree2.getHexProof(elements2[0]);

      const claims: Claim[] = [
        {
          distribution: distribution1,
          balance: claimedBalance1,
          rewarder: rewarder.address,
          rewardToken: rewardToken.address,
          merkleProof: proof1,
        },
        {
          distribution: bn(2),
          balance: claimedBalance2,
          rewarder: rewarder.address,
          rewardToken: rewardToken.address,
          merkleProof: proof2,
        },
      ];

      await expectBalanceChange(
        () => merkleOrchard.connect(lp1).claimDistributions(lp1.address, claims),
        rewardTokens,
        [{ account: lp1, changes: { DAI: bn('2234') } }]
      );
    });

    it('allows the user to claim multiple distributions at once to internal balance', async () => {
      const claimedBalance1 = bn('1000');
      const claimedBalance2 = bn('1234');

      const proof1: BytesLike[] = merkleTree1.getHexProof(elements1[0]);
      const proof2: BytesLike[] = merkleTree2.getHexProof(elements2[0]);

      const claims: Claim[] = [
        {
          distribution: distribution1,
          balance: claimedBalance1,
          rewarder: rewarder.address,
          rewardToken: rewardToken.address,
          merkleProof: proof1,
        },
        {
          distribution: bn(2),
          balance: claimedBalance2,
          rewarder: rewarder.address,
          rewardToken: rewardToken.address,
          merkleProof: proof2,
        },
      ];

      await expectBalanceChange(
        () => merkleOrchard.connect(lp1).claimDistributionsToInternalBalance(lp1.address, claims),
        rewardTokens,
        [{ account: lp1, changes: { DAI: bn('2234') } }],
        vault
      );
    });

    it('reports distributions as unclaimed', async () => {
      const expectedResult = [false, false];
      const result = await merkleOrchard.claimStatus(lp1.address, rewardToken.address, rewarder.address, 1, 2);
      expect(result).to.eql(expectedResult);
    });

    it('returns an array of merkle roots', async () => {
      const expectedResult = [root1, root2];
      const result = await merkleOrchard.merkleRoots(rewardToken.address, rewarder.address, 1, 2);
      expect(result).to.eql(expectedResult); // "claim status should be accurate"
    });

    describe('with a callback', () => {
      let callbackContract: Contract;
      let claims: Claim[];

      sharedBeforeEach('set up mock callback', async () => {
        callbackContract = await deploy('MockRewardCallback');

        const proof1: BytesLike[] = merkleTree1.getHexProof(elements1[0]);
        const proof2: BytesLike[] = merkleTree2.getHexProof(elements2[0]);

        claims = [
          {
            distribution: bn(1),
            balance: claimBalance1,
            rewarder: rewarder.address,
            rewardToken: rewardToken.address,
            merkleProof: proof1,
          },
          {
            distribution: bn(2),
            balance: claimBalance2,
            rewarder: rewarder.address,
            rewardToken: rewardToken.address,
            merkleProof: proof2,
          },
        ];
      });

      it('allows a user to claim the reward to a callback contract', async () => {
        const expectedReward = claimBalance1.add(claimBalance2);
        const calldata = utils.defaultAbiCoder.encode([], []);

        await expectBalanceChange(
          () =>
            merkleOrchard
              .connect(lp1)
              .claimDistributionsWithCallback(lp1.address, claims, callbackContract.address, calldata),
          rewardTokens,
          [{ account: callbackContract.address, changes: { DAI: ['very-near', expectedReward] } }],
          vault
        );
      });

      it('calls the callback on the contract', async () => {
        const calldata = utils.defaultAbiCoder.encode([], []);

        const receipt = await (
          await merkleOrchard
            .connect(lp1)
            .claimDistributionsWithCallback(lp1.address, claims, callbackContract.address, calldata)
        ).wait();

        expectEvent.inIndirectReceipt(receipt, callbackContract.interface, 'CallbackReceived', {});
      });
    });

    describe('When a user has claimed one of their allocations', async () => {
      sharedBeforeEach(async () => {
        const claimedBalance1 = bn('1000');
        const proof1 = merkleTree1.getHexProof(elements1[0]);

        const claims: Claim[] = [
          {
            distribution: distribution1,
            balance: claimedBalance1,
            rewarder: rewarder.address,
            rewardToken: rewardToken.address,
            merkleProof: proof1,
          },
        ];

        await merkleOrchard.connect(lp1).claimDistributions(lp1.address, claims);
      });

      it('reports one of the distributions as claimed', async () => {
        const expectedResult = [true, false];
        const result = await merkleOrchard.claimStatus(lp1.address, rewardToken.address, rewarder.address, 1, 2);
        expect(result).to.eql(expectedResult);
      });
    });
  });
});