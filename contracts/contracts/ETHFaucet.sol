// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

/// @title 测试用 ETH 水龙头
/// @notice 网站上的"领取测试以太币"功能由这个合约提供：每个地址每 24 小时可以领 1 ETH。
/// @dev 部署后需要先给合约转一些 ETH 作为储备。
contract ETHFaucet {
    uint256 public constant DRIP = 1 ether;
    uint256 public constant COOLDOWN = 24 hours;

    mapping(address => uint256) public lastClaimAt;

    event ETHClaimed(address indexed user, uint256 amount);

    /// @notice 领取测试以太币
    function claim() external returns (uint256 amount) {
        uint256 last = lastClaimAt[msg.sender];
        require(last == 0 || block.timestamp >= last + COOLDOWN, "ETHFaucet: cooldown");

        lastClaimAt[msg.sender] = block.timestamp;
        amount = DRIP;

        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "ETHFaucet: transfer failed");

        emit ETHClaimed(msg.sender, amount);
    }

    /// @notice 合约 ETH 储备
    function balance() external view returns (uint256) {
        return address(this).balance;
    }

    receive() external payable {}
}
